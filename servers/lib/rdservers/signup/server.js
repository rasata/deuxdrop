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
 * Allow a new user/identity to register itself with this server.  Registration
 *  may potentially happen quickly in-band or require some out-of-band
 *  verification.
 *
 * General criteria for signup could be:
 * - Open signup, all supplicants accepted, but lacking any fallback account
 *    recovery stuff.
 * - Out-of-band limited identify verification (+ for account recovery), ex:
 *    send e-mail with confirmation URL, text message with confirmation URL.
 * - In-band signed attestation from trusted source, such as a friend saying
 *    they are cool (possibly throttled by invite caps) or a company
 *    authority signing an attestation.
 *
 * Our current approach is a variant of limited identity verification that
 *  reuses our webfinger support.  The user needs to put a link in their
 *  webfinger profile that is a link to our server and names the root
 *  identity key they are using.  This expresses a willingness by the owner
 *  of the e-mail address to be associated with the identity in question and
 *  allows us to then limit account signup to specific domains or e-mail
 *  addresses in our initial testing configuration.
 * XXX And this is not yet implemented.
 *
 * The link we generate is predictable; we do not hash the identity key with a
 *  secret or anything like that.  It's just the identity key in base 64.
 *
 *
 * @typedef[ClientSignupBundle @dict[
 *   @key[selfIdent PersonSelfIdentBlob]{
 *     The identity that is signing up.
 *   }
 *   @key[clientAuths @listof[PersonClientAuthBlob]]{
 *     Authorized clients to allow to contact the server on the identity's
 *     behalf (signed by the `longtermSignPubKey`).  The first entry must be
 *     the client that is attempting to perform the signup operation.
 *   }
 *   @key[storeKeyring PersistedSimpleBoxingKeyring]
 *   @key[because SignupBecause]{
 *     The client's reason we should sign it up.
 *   }
 * ]]{
 *
 * }
 *
 * @typedef[SignupBecause @dict[
 *   @key[type "existing-account:webfinger"]
 *   @key[accountName String]{
 *     The e-mail address in question.
 *   }
 * ]]{
 *   Currently just our webfinger mechanism.
 * }
 **/

define(
  [
    'rdcommon/log',
    'rdcommon/taskidiom', 'rdcommon/taskerrors',
    'rdcommon/crypto/keyops',
    'rdcommon/identities/pubident',
    'jwcrypto/jwcert', 'jwcrypto/vep', 'jwcrypto/jwt',
    'module',
    'exports'
  ],
  function(
    $log,
    $task, $taskerrors,
    $keyops,
    $pubident,
    $jwc_jwcert, $jwc_vep, $jwc_jwt,
    $module,
    exports
  ) {

var LOGFAB = exports.LOGFAB = $log.register($module, {});

var taskMaster = $task.makeTaskMasterForModule($module, LOGFAB);

/**
 * Repurpose the challenge mechanism to convey that this request will never
 *  succeed.
 */
const CHALLENGE_NEVER = "never";
/**
 * They already have an account with us.  The most likely explanations for this
 *  are:
 * - They got disconnected during a successful signup process and so they never
 *    heard they were successful.
 * - Client bug, it has forgotten it has an account, etc.
 * - An attack attempting to clobber the existing account details with a
 *    different set of details.  This would be useful in the case where the
 *    client registering is not currently authorized on the account or does
 *    not have the credentials required to accomplish its goal within the
 *    legal account-manipulation framework.
 */
const CHALLENGE_ALREADY_SIGNED_UP = "already-signed-up";
/**
 * The Browser ID assertion was no good.  This covers:
 * - Totally gibberish.
 * - Valid but does not match the e-mail address.
 * - Valid but expired beyond what we are willing to accept.
 */
const CHALLENGE_INVALID_BROWSERID = 'bad-browserid-assertion';

const CHALLENGE_SERVER_PROBLEM = 'server-problem-try-again-later';

const SIGNUP_TEMPORARY_INVOCATION = "auto:hackjob";

/**
 * Validate that the request, regardless of challenges/responses, is in fact a
 *  well-formed and legitimate request.
 *
 * This is implemented as a soft failure task which means that all failures end
 *  up resolving our promise with `false` and success ends up resolving our
 *  promise with whatever it was resolved with.  This is done so that if we
 *  fail, the task that created us will not immediately fail in turn, but can
 *  react to our failure.
 */
var ValidateSignupRequestTask = taskMaster.defineSoftFailureTask({
  name: 'validateSignupRequest',
  args: ['msg', 'clientPublicKey', 'serverConfig'],
  steps: {
    /**
     * Make sure the self-ident blob is self-consistent, especially that it
     *  names us as the server of record.
     */
    validateSelfIdent: function() {
      // - self-consistent
      this.personSelfIdentPayload = $pubident.assertGetPersonSelfIdent(
                                      this.msg.selfIdent, null); // (throws)
      // - names us
      // Verify they are using our self-signed blob verbatim.
      if (this.personSelfIdentPayload.transitServerIdent !==
          this.serverConfig.selfIdentBlob)
        throw new $taskerrors.KeyMismatchError("transit server is not us");

      // - poco has a display name
      if (!this.personSelfIdentPayload.poco.hasOwnProperty("displayName"))
        throw new $taskerrors.MalformedPayloadError("No poco displayName");
    },
    /**
     * Make sure all named clients are authorized and that we are talking to one
     *  of them.
     */
    validateClientAuth: function() {
      var clientAuthBlobs = this.msg.clientAuths;
      if (!Array.isArray(clientAuthBlobs) || clientAuthBlobs.length === 0)
        throw new $taskerrors.MalformedPayloadError();

      // - assert all clients are authorized
      // (There is no leakage from returning on the first failure since an
      //  attacker is just as able as us to verify the clients are not
      //  authorized; the public key is in the self-ident payload after all.)
      var foundClientWeAreTalkingTo = false;
      // the client must be authorized by the ident's longterm signing key
      var authorizedKeys = [
        this.personSelfIdentPayload.root.longtermSignPubKey];
      var clientAuthsMap = {};
      for (var iAuth = 0; iAuth < clientAuthBlobs.length; iAuth++) {
        var clientAuth = $keyops.assertCheckGetAttestation(
                           clientAuthBlobs[iAuth], "client",
                           authorizedKeys);
        clientAuthsMap[clientAuth.authorizedKey] = clientAuthBlobs[iAuth];
        if (clientAuth.authorizedKey === this.clientPublicKey)
          foundClientWeAreTalkingTo = true;
      }

      // - assert we are talking to one of the authorized clients
      // If we are not, then it is notable that someone had at least one valid
      //  client authorization to tell us about.  Since client authorizations
      //  are a private matter between a client and server, this constitutes
      //  a potential data leak.
      if (!foundClientWeAreTalkingTo)
        throw new $taskerrors.UnauthorizedUserDataLeakError();

      return {
        selfIdentPayload: this.personSelfIdentPayload,
        clientAuthsMap: clientAuthsMap,
      };
    },
  },
});

var ProcessSignupTask = taskMaster.defineEarlyReturnTask({
  name: 'processSignup',
  args: ['msg', 'conn'],
  steps: {
    /**
     * Ensure the request is well-formed/legitimate.
     */
    validateSignupRequest: function() {
      return new ValidateSignupRequestTask(
        {msg: this.msg, clientPublicKey: this.conn.clientPublicKey,
         serverConfig: this.conn.serverConfig}, this.log);
    },
    /**
     * Convey permanent failure if the request was not valid.
     */
    dealWithInvalidRequest: function(validBits) {
      if (!validBits) {
        return this.respondWithChallenge(CHALLENGE_NEVER);
      }
      this.selfIdentPayload = validBits.selfIdentPayload;
      this.clientAuthsMap = validBits.clientAuthsMap;
      return undefined;
    },
    /**
     * You can't signup if you are already signed up...
     */
    checkForExistingAccount: function() {
      return this.conn.serverConfig.authApi.serverCheckUserAccount(
               this.selfIdentPayload.root.rootSignPubKey);
    },
    verifyNoExistingAccount: function(hasAccount) {
      if (hasAccount)
        return this.respondWithChallenge(CHALLENGE_ALREADY_SIGNED_UP);
      return undefined;
    },
    /**
     * Figure out what challenges could be used to authenticate this request.
     *
     * (The idea is to avoid a mismatch between our checking logic and our
     *  generation logic by having the checking logic depend on the generation
     *  logic.)
     */
    determineChallenges: function() {
      // in the future, this should come from the server config
      this.challenges = ['none', 'browserid'];
    },
    /**
     * If a challenge response is included, verify it is one of the ones we
     *  are allowing; if it is not, tell the client what is allowed.
     */
    checkOrGenerateChallenge: function() {
      // you pass without proof if 'none' is in the list.
      var passed = this.challenges.indexOf('none') !== -1, promises = [];
      for (var because in this.msg.because) {
        // ignore unsupported challenge types
        if (this.challenges.indexOf(because) === -1)
          continue;

        var result = null;
        switch (because) {
          case 'browserid':
            result = this.verifyBrowserId(this.msg.because[because]);
            break;
          case 'none':
            break;
          default:
            throw new Error("Unimplemented but server supported challenge");
            break;
        }

        if ($Q.isPromise(result))
          promises.push(result);
        else if (result)
          return this.respondWithChallenge(problemo);
      }

      if (promises.length) {
        var self = this;
        return when($Q.all(promises),
          function successish(results) {
            for (var i = 0; i < results.length; i++) {
              if (results[i])
                return self.respondWithChallenge(results[i]);
            }
            return undefined;
          },
          function exthrown() {
            // XXX logging/reporting of implementation failure
            return self.respondWithChallenge(CHALLENGE_SERVER_PROBLEM);
          });
      }
    },
    doTheSignup: function() {
      var poco = this.selfIdentPayload.poco;

      // XXX list them publicly for now.
      var publicListInfo = {
        displayName: poco.displayName,
      };

      return this.conn.serverConfig.authApi.serverCreateUserAccount(
        this.selfIdentPayload,
        this.msg.selfIdent,
        this.clientAuthsMap,
        this.msg.storeKeyring,
        publicListInfo);
    },
    tellThemTheyAreSignedUp: function() {
      this.conn.writeMessage({
        type: 'signedUp',
      });
      // (end of the line; not an early return)
      return this.conn.close();
    },
  },
  impl: {
    respondWithChallenge: function(challengeType) {
      this.conn.writeMessage({
        type: 'challenge',
        challenge: {
          mechanism: challengeType,
        },
      });
      return this.earlyReturn(this.conn.close());
    },

    validateClientOrigin: function(host) {
      // right now, only things that look like jetpack extensions are cool,
      //  which means, not a real domain name.  it would be nice if the
      //  "resource://" got in there a bit.
      if (host.indexOf('.') !== -1)
        return false;
      return true;
    },

    verifyBrowserId: function(assertion) {
      if (!this.selfIdentPayload.poco.hasOwnProperty("emails") ||
          (this.selfIdentPayload.poco.emails.length !== 1) ||
          (typeof(this.selfIdentPayload.poco.emails[0]) !== 'string'))
        return CHALLENGE_INVALID_BROWSERID;
      var userClaimedEmail = this.selfIdentPayload.poco.email[0];

      var bundle;
      try {
        bundle = $jwc_vep.unbundleCertsAndAssertion(assertion);
      }
      catch (ex) {
        return CHALLENGE_INVALID_BROWSERID;
      }

      // eh, for now, let's require the user to be fast about the signup
      //  process and use the true current time.  If there was user interaction
      //  required after the browser id step, we might want to allow limited
      //  backdating of our check.
      var deferred = $Q.defer, self = this;
      var validateAsOf = new Date();
      $jwc_jwcert.JWCert.verifyChain(
        bundle.certificates, validateAsOf,
        function rootCB(issuer, next) {
          // XXX either need to hardcode the browserid key or wait for them to
          //  implement the dns fetch logic.  Probably the former is the best
          //  stopgap.
        },
        function successCB(pk, principal) {
          var tok = new jwt.JWT();
          tok.parse(bundle.assertion);

          // - validate audience
          if (!self.validateClientOrigin(tok.audience)) {
            deferred.resolve(CHALLENGE_INVALID_BROWSERID);
            return;
          }

          if (principal.email !== userClaimedEmail) {
            deferred.resolve(CHALLENGE_INVALID_BROWSERID);
            return;
          }

          if (!tok.verify(pk)) {
            deferred.resolve(CHALLENGE_INVALID_BROWSERID);
            return;
          }

          deferred.resolve();
        },
        function errorCB(err) {
          deferred.resolve(CHALLENGE_SERVER_PROBLEM);
        }
      );
      return deferred.promise;
    },
  },
});

/**
 * Simple signup connection; most of the work is farmed out to
 *  `ProcessSignupTask` and its subsidiary tasks.
 */
function SignupConnection(conn) {
  this.conn = conn;
}
SignupConnection.prototype = {
  INITIAL_STATE: 'root',
  /**
   * Signup the user if they provided everything required, otherwise issue an
   *  appropriate set of challenges from which they can pick one to implement.
   *
   * @args[
   *   @param[msg ClientSignupBundle]
   * ]
   */
  _msg_root_signup: function(msg) {
    return new ProcessSignupTask(
      {msg: msg, conn: this.conn}, this.conn.log);
  },
};

var PhonebookTask = taskMaster.defineTask({
  name: 'phonebook',
  args: ['msg', 'conn'],
  steps: {
    scan_phonebook: function() {
      return this.conn.serverConfig.authApi.phonebookScanPublicListing();
    },
    report_results_and_close: function(selfIdentBlobs) {
      this.conn.writeMessage({
        type: 'listing',
        selfIdentBlobs: selfIdentBlobs,
      });
      return this.conn.close();
    },
  },
});

function PhonebookServerConnection(conn) {
  this.conn = conn;
}
PhonebookServerConnection.prototype = {
  INITIAL_STATE: 'root',

  /**
   * Request the listing of the peeps the client/server we are talking to is
   *  allowed to hear about.
   */
  _msg_root_listPeeps: function(msg) {
    return new PhonebookTask({msg: msg, conn: this.conn}, this.conn.log);
  },
};

exports.makeServerDef = function(serverConfig) {
  return {
    endpoints: {
      'signup.deuxdrop': {
        implClass: SignupConnection,
        serverConfig: serverConfig,
        authVerifier: function(endpoint, clientKey) {
          // (we have no identity on file)
          return true;
        },
      },
      'phonebook.deuxdrop': {
        implClass: PhonebookServerConnection,
        serverConfig: serverConfig,
        authVerifier: function(endpoint, clientKey) {
          // we could do something where we figure out if the other thing
          //  is someone we already know...
          return true;
        },
      },
    },
    urls: {
      '/.well-known/deuxdrop-server.selfident.json':
        function handleSelfIdent(request, response) {
          var selfIdent = serverConfig.selfIdentBlob,
              contents = JSON.stringify({selfIdent: selfIdent});
          response.writeHead(200, {
            //Yes, we really want anyone to be able to ask for the selfident
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'text/plain;charset=utf-8'
        });
        response.write(contents, 'utf8');
        response.end();
      }
    }
  };
};

}); // end define
