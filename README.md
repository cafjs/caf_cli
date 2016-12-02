# CAF.js (Cloud Assistant Framework)

Co-design permanent, active, stateful, reliable cloud proxies with your web app and gadgets.

See http://www.cafjs.com

## CAF Client Lib for node.js
[![Build Status](http://ci.cafjs.com/api/badges/cafjs/caf_cli/status.svg)](http://ci.cafjs.com/cafjs/caf_cli)



This repository contains a client CAF library for browser (using `browserify` and native websockets), cloud, scripting, and gadget (`node.js`).

The base interface is very similar to a websocket, but CAF dynamically adds methods for remote invocation with local argument checking.

For example, with the CA:

```
exports.methods = {
    __ca_init__: function(cb) {
        this.state.counter = 0;
        cb(null);
    },
    increment: function(cb) {
        this.state.counter = this.state.counter + 1;
        cb(null, this.state.counter);
    },
    decrement: function(cb) {
        this.state.counter = this.state.counter - 1;
        cb(null, this.state.counter);
    }
};
```

and the client code:

```
var URL = 'http://root-hello.vcap.me:3000/#from=foo-ca1&ca=foo-ca1';

var s = new caf_cli.Session(URL);

s.onopen = function() {
    async.waterfall([
        function(cb) {
            s.increment(cb);
        },
        function(counter, cb) {
            console.log(counter);
            s.decrement(cb);
        }
    ], function(err, counter) {
        if (err) {
            console.log(myUtils.errToPrettyStr(err));
        } else {
            console.log('Final count:' + counter);
            s.close();
        }
    });
};

s.onclose = function(err) {
    if (err) {
        console.log(myUtils.errToPrettyStr(err));
        process.exit(1);
    }
    console.log('Done OK');
};
```

the methods `increment` and `decrement` magically appear in `s` after we open the session. **I love javascript!**

Remote invocations are always serialized. The session locally buffers new requests until the previous ones have been processed. Session properties can be configured in the URL, or in a separate constructor argument. See {@link module:caf_cli/Session} for details.

There are two types of errors:

* Application error: propagated in the callback, no attempt to recover it.

* System error: after all the attempts to recover fail, the error is propagated in the `onclose` handler. The session is no longer usable.

Calling the `onclose` with no argument means the session closed normally, i.e., using its `close()` method.

Note that the `onerror` handler in the websocket interface is for *internal use* only. Just use `onclose`.

In some cases we want to execute multiple methods in a single transaction (see {@link external:caf_ca}). If one fails, we roll back both state changes and (delayed) external interactions for all of them.

This is easy in CAF.js, because methods that do not provide a callback are assumed to be multi-method calls:

```
...
s.onopen = function() {
    s.increment().decrement(function(err, counter) {
        if (err) {
            console.log(myUtils.errToPrettyStr(err));
        } else {
            console.log('Final count:' + counter);
            s.close();
        }
    });
};
...
```

In other cases, the CA will send notifications to one (or many) client(s). See
{@link external:caf_session}. Notifications are processed in the `onmessage` handler:

```
...
s.onmessage = function(msg) {
    var notif = caf_cli.getMethodArgs(msg)[0];
    console.log('Got notification in client:' + notif);
};
...
```

See `examples/helloworld` for full code examples.

Session objects also provide end-to-end encryption and time synchronization. See {@link module:caf_cli/cryptoSession} and {@link module:caf_cli/TimeAdjuster}.
