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

var json_rpc = require('caf_transport').json_rpc;
var srp = require('caf_security').srp;
var assert = require('assert');
var urlParser = require('url');

var session = require('./Session');



var toUrlWS = function(url) {
    var parsedURL = urlParser.parse(url);
    parsedURL.protocol = (parsedURL.protocol === 'http:' ?
                          'ws:': parsedURL.protocol);
    parsedURL.protocol = (parsedURL.protocol === 'https:' ?
                          'wss:': parsedURL.protocol);
    return urlParser.format(parsedURL);
};

/**
 *
 *
 * options type is Session.options argument plus:
 *
 * {
 *    password {string},
 *    accountsURL {string}: The url for a authentication service,
 *    unrestrictedToken {boolean} : True if the token authenticates to all apps
 *    appPublisher {string=}:  Publisher of the app hosting CAs.
 *    appLocalName {string=}: Name of the app in the 'appPublisher' context.
 *    durationInMsec {number=} Time in msec from 'now' till token expires.
 *
 * }
 *
 *
 */
var TokenFactory = exports.TokenFactory = function(options) {

    var that = {};

    var accOptions = {
        from : json_rpc.DEFAULT_FROM,
        ca: json_rpc.DEFAULT_FROM,
        disableBackchannel : true,
        log : options.log,
        maxRetries: options.maxRetries,
        retryTimeoutMsec: options.retryTimeoutMsec,
        timeoutMsec: options.timeoutMsec
    };

    assert.equal(typeof options.accountsURL, 'string',
                 "'options.accountsURL' is not a string");
    var accountsURL = toUrlWS(options.accountsURL);

    assert.equal(typeof options.password, 'string',
                 "'options.password' is not a string");

    assert.equal(typeof options.unrestrictedToken, 'boolean',
                 "'options.unrestrictedToken' is not a boolean");

    var split = srp.utils.splitName(options.ca);
    var caOwner = split[0];
    var caLocalName = split[1];

    assert.equal(typeof caOwner, 'string', "'caOwner' is not a string");

    var srpClient = srp.clientInstance(caOwner, options.password);

    var newConstraint = function() {
        var durationInMsec = options.durationInMsec;

        durationInMsec && assert.ok(typeof durationInMsec === 'number',
                                    "'durationInMsec' is not a number");
        (typeof durationInMsec === 'number') &&
            assert.ok(durationInMsec > 0, "'durationInMsec' is not positive");

        var result = {caOwner : caOwner};
        if (durationInMsec) {
            result.durationInMsec = durationInMsec;
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

    var tokenConstraint = newConstraint();

    that.newToken = function(msg, cb) {
        try {
            var accounts = new session.Session(accountsURL, null,  accOptions);
            var token = null;
            accounts.onopen = function() {
                srpClient.asyncToken(accounts, tokenConstraint,
                                     function(err, tokenData) {
                                         token = tokenData;
                                         accounts.close(err);
                                     });
            };
            accounts.onclose = function(err) {
                cb(err, token);
            };
        } catch (err) {
            cb(err);
        }
    };

    return that;

};

