/*!
Copyright 2013 Hewlett-Packard Development Company, L.P.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
'use strict';
/**
 * Creates authentication tokens for a node.js client.
 *
 * See `tokenFactoryOptionsType` in file `types.js` for the security
 * properties in `sessionOptionsType`.
 *
 * @module caf_cli/TokenFactory
 */

const json_rpc = require('caf_transport').json_rpc;
const assert = require('assert');
const session = require('./Session');


const getAccountsURL = exports.getAccountsURL = function(options, msg) {
    const accURLInMsg = msg && json_rpc.accountsURL(msg);
    const accountsURL = options.accountsURL || accURLInMsg;
    assert.equal(typeof accountsURL, 'string',
                 "'accountsURL' is not a string");
    if (accURLInMsg && (accountsURL !== accURLInMsg)) {
        options.log && options.log('Warning: Ignoring accountsURL hint ' +
                                   accURLInMsg);
    }
    return accountsURL;
};


/**
 * Constructor.
 *
 * @param {sessionOptionsType} options Extended properties.
 *
 * @memberof! module:caf_cli/TokenFactory
 * @alias TokenFactory
 */
exports.TokenFactory = function(options) {

    const that = {};

    const split = json_rpc.splitName(options.from);
    assert.equal(split.length, 2, "Invalid 'options.from'");
    const caOwner = split[0];
    const caLocalName = split[1];

    assert.equal(typeof caOwner, 'string', "'caOwner' is not a string");

    const accFrom = json_rpc.joinName(json_rpc.DEFAULT_FROM_USERNAME,
                                      caOwner.substring(0, 2));

    const accOptions = {
        from: accFrom,
        ca: accFrom,
        disableBackchannel: true,
        log: options.log,
        maxRetries: options.maxRetries,
        retryTimeoutMsec: options.retryTimeoutMsec,
        timeoutMsec: options.timeoutMsec
    };

    assert.equal(typeof options.password, 'string',
                 "'options.password' is not a string");

    assert.equal(typeof options.unrestrictedToken, 'boolean',
                 "'options.unrestrictedToken' is not a boolean");


    const newConstraint = function() {
        const durationInSec = options.durationInSec;

        durationInSec && assert.ok(typeof durationInSec === 'number',
                                   "'durationInSec' is not a number");
        (typeof durationInSec === 'number') &&
            assert.ok(durationInSec > 0, "'durationInSec' is not positive");

        const result = {caOwner: caOwner};
        if (durationInSec) {
            result.durationInSec = durationInSec;
        }
        if (!options.unrestrictedToken) {
            assert.equal(typeof caLocalName, 'string',
                         "'caLocalName' is not a string");
            assert.equal(typeof options.appPublisher, 'string',
                         "'options.appPublisher' is not a string");
            assert.equal(typeof options.appLocalName, 'string',
                         "'options.appLocalName' is not a string");
            result.caLocalName = caLocalName;
            result.appPublisher = options.appPublisher;
            result.appLocalName = options.appLocalName;
        }
        return result;
    };


    /**
     * Negotiates a new authentication token.
     *
     * @param {msgType} msg A `notAuthenticated` error message.
     * @param {cbType} cb A callback to return the new token or an error.
     *
     * @memberof! module:caf_cli/TokenFactory#
     * @alias newToken
     */
    that.newToken = function(msg, cb) {
        try {
            var token = null;
            var justOnce = true;

            const client = options.securityClient.clientInstance(
                caOwner, options.password
            );

            const tokenConstraint = newConstraint();

            const s = session.Session(getAccountsURL(options, msg), null,
                                      accOptions);

            s.onopen = function() {
                client.asyncToken(s, tokenConstraint, function(err, data) {
                    token = data;
                    s.close(err);
                });
            };

            s.onclose = function(err) {
                if (justOnce) {
                    justOnce = false;
                    cb(err, token);
                }
            };

            s.onerror = function(err) {
                if (justOnce) {
                    justOnce = false;
                    cb(err, token);
                }
            };

        } catch (err) {
            cb(err);
        }
    };

    return that;
};
