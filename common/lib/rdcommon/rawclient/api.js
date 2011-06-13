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
 * The raw client provides reliable low level interaction with a mailstore
 *  server while abstracting away key management concerns.  It is intended to
 *  exist on a background (non-UI) thread on the client device.  Interaction
 *  with the UI thread should be handled at a higher level that is aware of the
 *  UI's current "focus".
 *
 * "Reliable" in this sense means that the consumer of the API does not need to
 *  build its own layer to make sure we do the things it asks.  At the current
 *  time, we in fact do not bother persisting anything, but at some point we
 *  will.
 **/

define(
  [
    'rdcommon/log',
    '../conversations/generator',
    'module',
    'exports'
  ],
  function(
    $log,
    $conv_generator,
    $module,
    exports
  ) {

function RawClientAPI(myFullIdent, serverSelfIdent) {
  this._fullIdent = myFullIdent;
  this._serverSelfIdent = serverSelfIdent;

  this.log = LOGFAB.rawClient(this, null,
                              []);
}
RawClientAPI.prototype = {
  createConversation: function() {
  },
  replyToConversation: function() {
  },
  inviteToConversation: function() {
  },

  pinConversation: function() {
  },
  updateWatermarkForConversation: function() {
  },

  deleteConversation: function() {
  },

};
exports.RawClientAPI = RawClientAPI;

var LOGFAB = exports.LOGFAB = $log.register($module, {
  rawClient: {
    // we are a client/server client, even if we are smart for one
    type: $log.CONNECTION,
    subtype: $log.CLIENT,
    semanticIdent: {
      clientIdent: 'key',
      _l1: null,
      serverIdent: 'key',
    },
    stateVars: {
      haveConnection: true,
    },
  }
});

}); // end define