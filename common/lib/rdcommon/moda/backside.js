/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at:
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Mozilla Raindrop Code.
 *
 * The Initial Developer of the Original Code is
 *   The Mozilla Foundation
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Andrew Sutherland <asutherland@asutherland.org>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

/**
 * Implements the moda worker-thread logic that handles communicating with the
 *  mailstore server and local storage of data on the device.  It has a
 *  reference to the rawclient instance and exposes it to the UI thread which
 *  uses the `ModaBridge` exposed API.
 *
 * Note that depending on the execution model, this logic may actually be
 *  time-sliced with the ui-thread logic.  Additionally, even if this logic does
 *  end up in a worker thread, it may have to rely on the UI-thread for all
 *  of its I/O.  This will be required on Firefox, at least until WebSockets and
 *  IndexedDB get exposed to workers.
 **/

define(
  [
    'q',
    'rdcommon/log',
    'rdcommon/serverlist',
    'module',
    'exports'
  ],
  function(
    $Q,
    $log,
    $serverlist,
    $module,
    exports
  ) {
const when = $Q.when;

const NS_PEEPS = 'peeps',
      NS_CONVBLURBS = 'convblurbs', NS_CONVALL = 'convall',
      NS_SERVERS = 'servers';

/**
 * The other side of a ModaBridge instance/connection.  This is intended to be
 *  a reasonably lightweight layer on top
 *
 * @args[
 *   @param[rawClient RawClientAPI]
 *   @param[name String]{
 *     A unique string amongst all other ModaBackside instances trying to
 *     talk to the same `RawClientAPI`/`NotificationKing` instance.  Normally
 *     the rendezvous logic would allocate these id's.
 *   }
 *   @param[_logger Logger]
 * ]
 */
function ModaBackside(rawClient, name, _logger) {
  this.name = name;
  this._log = LOGFAB.modaBackside(this, _logger, name);
  this._rawClient = rawClient;
  this._store = rawClient.store;
  this._notif = this._store._notif;

  this._bridgeName = null;
  this._sendObjFunc = null;

  this._querySource = null;

  var self = this;
}
exports.ModaBackside = ModaBackside;
ModaBackside.prototype = {
  toString: function() {
    return '[ModaBackside]';
  },
  toJSON: function() {
    return {type: 'ModaBackside'};
  },

  /**
   * Hack to establish a *fake* *magic* link between us and a bridge.  ONLY
   *  FOR USE BY UNIT TESTS.
   */
  XXXcreateBridgeChannel: function(name, bridgeHandlerFunc) {
    this._bridgeName = name;
    this._sendObjFunc = function(msg) {
      var jsonRoundtripped = JSON.parse(JSON.stringify(msg));
      bridgeHandlerFunc(jsonRoundtripped);
    };

    this._querySource = this._notif.registerNewQuerySource(name, this);

    var self = this;
    return this._received.bind(this);
  },

  //////////////////////////////////////////////////////////////////////////////
  // Lifecycle

  /**
   * Indicate that the other side is dead and we should kill off any live
   *  queries, etc.
   */
  dead: function() {
    this._notif.unregisterQuerySource(this.name);
  },

  //////////////////////////////////////////////////////////////////////////////
  // Send to the ModaBridge from the NotificationKing

  send: function(msg) {
    this._log.send(msg);
    this._sendObjFunc(msg);
  },

  //////////////////////////////////////////////////////////////////////////////
  // Receive from the ModaBridge, boss around NotificationKing, LocalStore

  /**
   * Handle messages from the `ModaBridge`, re-dispatching to helper methods
   *  named like "_cmd_COMMANDNAME".
   */
  _received: function(boxedObj) {
    var cmdFunc = this['_cmd_' + boxedObj.cmd];
    this._log.handle(boxedObj.cmd, this, cmdFunc, boxedObj.name,
                     boxedObj.payload);
  },

  /**
   * In the event that we encounter a problem procesing a query, we should
   *  remove it from our tracking mechanism and report to the other side that
   *  we failed and will not be providing any responses.
   */
  _needsbind_queryProblem: function(queryHandle, err) {
    this._log.queryProblem(err);
    this._notif.forgetTrackedQuery(queryHandle);
    this.send({
      type: 'query',
      handle: queryHandle.uniqueId,
      op: 'dead',
    });
  },

  _cmd_queryPeeps: function(bridgeQueryName, queryDef) {
    var queryHandle = this._notif.newTrackedQuery(
                        this._querySource, bridgeQueryName,
                        NS_PEEPS, queryDef);
    when(this._store.queryAndWatchPeepBlurbs(queryHandle), null,
         this._needsbind_queryProblem.bind(this, queryHandle));
  },

  _cmd_queryPeepConversations: function(bridgeQueryName, payload) {
    var queryHandle = this._notif.newTrackedQuery(
                        this._querySource, bridgeQueryName,
                        NS_CONVBLURBS, payload.query);
    // map the provided peep local name to z true name
    var peepRootKey = this._notif.mapLocalNameToFullName(this._querySource,
                                                         NS_PEEPS,
                                                         payload.peep);
    when(this._store.queryAndWatchPeepConversationBlurbs(queryHandle,
                                                         peepRootKey,
                                                         payload.query),
         null,
         this._needsbind_queryProblem.bind(this, queryHandle));
  },

  /**
   * Transform a server ident blob for transport to a `ModaBridge`.
   */
  _transformServerIdent: function(serverIdentBlob, serverIdent) {
    if (!serverIdent)
      serverIdent = $pubident.assertGetServerSelfIdent(serverIdentBlob);

    return {
      url: serverIdent.url,
      displayName: serverIdent.meta.displayName,
      blob: serverIdentBlob,
    };
  },

  _cmd_queryServers: function(bridgeQueryName, payload) {
  },

  _cmd_killQuery: function(bridgeQueryName, ignored) {
    this._notif.forgetTrackedQuery(bridgeQueryName);
  },

  _cmd_whoAmI: function() {
    var serverInfo = null;
    if (this._rawClient._transitServerBlob)
      serverInfo = this._transformServerIdent(
                     this._rawClient._transitServerBlob,
                     this._rawClient._transitServer);
    this.send({
      type: 'whoAmI',
      poco: this._rawClient.getPoco(),
      server: serverInfo,
    });
  },

  _cmd_updatePoco: function(_ignored, newPoco) {
    this._rawClient.updatePoco(newPoco);
  },

  _cmd_signupDangerouslyUsingDomainName: function() {
  },

  _cmd_signupUsingServerSelfIdent: function() {
  },

  //////////////////////////////////////////////////////////////////////////////
};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  modaBackside: {
    type: $log.DAEMON,
    subtype: $log.DAEMON,
    calls: {
      handle: {cmd: true},
    },
    TEST_ONLY_calls: {
      handle: {name: true, payload: false},
    },
    events: {
      send: {},
    },
    TEST_ONLY_events: {
      send: {msg: false},
    },
    errors: {
      queryProblem: {ex: $log.EXCEPTION},
    },
  },
});

}); // end define
