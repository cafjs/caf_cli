# CAF.js (Cloud Assistant Framework)

Co-design permanent, active, stateful, reliable cloud proxies with your web app and gadgets.

See http://www.cafjs.com

## CAF Client Lib for node.js
[![Build Status](https://travis-ci.org/cafjs/caf_cli.svg?branch=master)](https://travis-ci.org/cafjs/caf_cli)



This repository contains a client CAF library for browser (using `browserify` and native websockets), cloud, scripting, and gadget (`node.js`).

The base interface is very similar to a websocket, but CAF dynamically adds remote invocation methods with local argument checking.

For example, with the CA:

```
exports.methods = {
    async __ca_init__() {
        this.state.counter = 0;
        return [];
    },
    async increment() {
        this.state.counter = this.state.counter + 1;
        return [null, this.state.counter];
    },
    async decrement() {
        this.state.counter = this.state.counter - 1;
        return [null, this.state.counter];
    }
};
```

and the client code:

```
var URL = 'http://root-hello.vcap.me:3000/#from=foo-ca1&ca=foo-ca1';
var s = new caf_cli.Session(URL);
s.onopen = async function() {
    try {
        var counter = await s.increment().getPromise();
        console.log(counter);
        counter = await s.decrement().getPromise();
        console.log('Final count:' + counter);
        s.close();
    } catch (ex) {
        s.close(ex);
    }
}
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

### Errors

There are two types of errors:

* Application error: propagated in the callback or exception in `await`, no attempt to recover it.

* System error: after all the attempts to recover fail, the error is propagated in the `onclose` handler. The session is no longer usable.

Triggering the `onclose` with no argument means the session closed normally, i.e., using its `close()` method.

Note that the `onerror` handler in the websocket interface is for *internal use* only. Just use `onclose`.

### Multi-method

In some cases we want to execute multiple methods in a single transaction (see {@link external:caf_ca}). If one fails, we roll back all state changes and (delayed) external interactions.

This is easy in CAF.js, because methods that do not provide a callback are assumed to be multi-method calls:

```
...
s.onopen = async function() {
    try {
        var counter = await s.increment().decrement().getPromise();
        console.log('Final count:' + counter);
        s.close();
    } catch (err) {
        s.close(err);
    }
}
...
```

### Notifications

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

### Other

Session objects also provide end-to-end encryption and time synchronization. See {@link module:caf_cli/cryptoSession} and {@link module:caf_cli/TimeAdjuster}.
