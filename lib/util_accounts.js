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

"use strict";
/**
 * Helper functions to interact with an external `accounts` service.
 *
 */
var url = require('url');
var Session = require('./Session');

var CA_PASSWORD = 'nobody';
var CA_NAME = 'nobody_accounts';

var patchUrl = function(serviceUrl) {
    var parsedUrl = url.parse(serviceUrl);
    parsedUrl.pathname = '/ca/' + CA_NAME;
    return url.format(parsedUrl);
};

exports.requestToken = function(accountsUrl, proxy, log, caOwner, password,
                                url, caLocalName, cb) {
    if (accountsUrl) {
        var newSpec = {
            proxy: proxy,
            url: patchUrl(accountsUrl),
            disableBackChannel: true,
            password: CA_PASSWORD,
            log: log
        };
        var session = new Session.Session(newSpec);
        session.on('error', function(err) { cb(err);});
        var cb1 = function(err, data) {
            session.shutdown();
            if (err) {
                cb(err);
            } else {
                if (typeof data === 'object') {
                    cb(null, data.token);
                } else {
                    cb(null, null);
                }
            }
        };
        session.remoteInvoke('login', [caOwner, password, url,
                                       caLocalName, false], cb1);
    } else {
        cb("Error: no accounts service URL");
    }
};
