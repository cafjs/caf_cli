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
var assert = require('assert');
var urlParser = require('url');
var session = require('./Session');


/**
 * Create authentication tokens for a node.js client.
 *
 * 'options' type is Session.options argument plus:
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

    assert.equal(typeof options.password, 'string',
                 "'options.password' is not a string");

    assert.equal(typeof options.unrestrictedToken, 'boolean',
                 "'options.unrestrictedToken' is not a boolean");

    var split = json_rpc.splitName(options.from);
    var caOwner = split[0];
    var caLocalName = split[1];

    assert.equal(typeof caOwner, 'string', "'caOwner' is not a string");


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

    that.newToken = function(cb) {
        try {
            var token = null;
            var justOnce = true;

            var client = options.securityClient
                .clientInstance(caOwner, options.password);

            var tokenConstraint = newConstraint();

            var s = new session.Session(options.accountsURL, null, accOptions);

            s.onopen = function() {
                client.asyncToken(s, tokenConstraint, function(err, data) {
//                                  console.log(data);
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

