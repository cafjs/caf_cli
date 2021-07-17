# Caf.js

Co-design cloud assistants with your web app and IoT devices.

See https://www.cafjs.com

## Client Library

[![Build Status](https://github.com/cafjs/caf_cli/actions/workflows/push.yml/badge.svg)](https://github.com/cafjs/caf_cli/actions/workflows/push.yml)

This repository contains a `Caf.js` client library for browser (using `browserify` and native websockets), cloud, scripting, and gadget (`node.js`).

The interface is similar to the websocket client API, but `Caf.js` dynamically extends it with remote methods and local argument checking.

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
s.onopen = async () => {
    try {
        let counter = await s.increment().getPromise();
        console.log(counter);
        counter = await s.decrement().getPromise();
        console.log('Final count:' + counter);
        s.close();
    } catch (ex) {
        s.close(ex);
    }
}
s.onclose = (err) => {
    if (err) {
        console.log(myUtils.errToPrettyStr(err));
        process.exit(1);
    }
    console.log('Done OK');
};
```

The methods `increment` and `decrement` magically appear in `s` after we open the session. **I love JavaScript!**

Remote invocations are always serialized, i.e., the session object locally buffers new requests until the previous ones have been processed. The session properties can be configured in the URL, or in an extra constructor argument. See {@link module:caf_cli/Session} for details.

We can set a maximum queue size for non-started requests with the option `maxQueueLength`. If exceeded, the oldest request gets dequeued, and an application error, with the attribute  `maxQueueLength` set to `true`, will propagate in the callback of the discarded request. The goal is to apply backpressure to slow down the client.

### Errors

There are two types of errors:

* Application error: propagated in the callback or exception in `await`, no attempt to recover it, your logic knows best how to handle it.

* System error: after all the attempts to recover fail, the error is propagated in the `onclose` handler. The session is no longer usable.

Triggering the `onclose` with no argument means the session closed normally, i.e., using its `close()` method.

Note that the `onerror` handler in the websocket interface is for *internal use* only. Just use `onclose`.


### Multi-method

In some cases we want to execute multiple methods in a single transaction (see {@link external:caf_ca}). If one fails, we roll back all state changes and (delayed) external interactions.

This is easy in `Caf.js`, because methods that do not provide a callback are assumed to be multi-method calls:

```
...
s.onopen = async function() {
    try {
        const counter = await s.increment().decrement().getPromise();
        console.log('Final count:' + counter);
        s.close();
    } catch (err) {
        s.close(err);
    }
}
...
```

### Notifications

The CA can also send notifications to one (or many) client(s), see
{@link external:caf_session} for details. Notifications are processed in the `onmessage` handler:

```
...
s.onmessage = function(msg) {
    const notif = caf_cli.getMethodArgs(msg)[0];
    console.log('Got notification in client:' + notif);
};
...
```

See `examples/helloworld` for full code examples.

### Other

Session objects also provide end-to-end encryption and time synchronization. See {@link module:caf_cli/cryptoSession} and {@link module:caf_cli/TimeAdjuster}.
