
//Sample server taken from socket.io examples and hacked up.

/*jslint strict: false, nomen: false, indent: 2 */
/*global require: false, process: false, __dirname: false, console: false */

var http = require('http'),
    url = require('url'),
    fs = require('fs'),
    path = require('path'),
    sys = require(process.binding('natives').util ? 'util' : 'sys'),
    io = require('socket.io'),
    redisLib = require('redis'),
    paperboy = require('paperboy'),
    md5 = require('md5'),
    clients = {},
    convCache = {},
    redis = redisLib.createClient(),
    server, listener, actions;

function send(id, message) {
  var clientList = clients[id];
  clientList.forEach(function (client) {
    client.send(message);
  });
}

function multiBulkToStringArray(data) {
  return data.map(function (item) {
    return item.toString();
  });
}

function peepSort(a, b) {
  if (a.name > b.name) {
    return 1;
  } else if (a.name < b.name) {
    return -1;
  } else {
    return 0;
  }
}

redis.on('error', function (err) {
  console.log('Redis error: ' + err);
});

actions = {

  'signIn': function (data, client) {
    var id = data.userId,
        name = data.userName,
        clientList = clients[id] || (clients[id] = []),
        pic = 'http://www.gravatar.com/avatar/' +
              md5.hex_md5(id.trim().toLowerCase());

    client._deuxUserId = id;

    //Add the user ID to the list of users.
    redis.sadd('users', id);

    //Add the user to the store
    redis.hmset(id, 'id', id, 'name', name, 'pic', pic);

    clientList.push(client);

    client.send(JSON.stringify({
      action: 'signInComplete',
      user: {
        id: id,
        name: name,
        pic: pic
      }
    }));
  },

  'disconnect': function (data, client) {
    var id = client._deuxUserId,
        clientList = clients[id],
        index;

    if (!id) {
      //This client did not have a user ID associated with it, drop it.
      return;
    }

    index = clientList.indexOf(client);
    if (index === -1) {
      console.log('HUH? Disconnect called, but cannot find client.');
    } else {
      clientList.splice(index, 1);
    }
  },

  'users': function (data, client) {
    //Pull a list of users from redis.
    redis.smembers('users', function (err, list) {
      var multi;
      if (list) {
        list = multiBulkToStringArray(list);
        list.sort(peepSort);

        //Fetch individual user records.
        multi = redis.multi();
        list.forEach(function (id) {
          multi.hgetall(id);
        });
        multi.exec(function (err, hashes) {
          client.send(JSON.stringify({
            action: 'usersResponse',
            items: hashes
          }));
        });
      } else {
        client.send(JSON.stringify({
          action: 'usersResponse',
          items: []
        }));
      }
    });
  },

  'peeps': function (data, client) {
    var userId = client._deuxUserId;

    redis.smembers('peeps:' + userId, function (err, list) {
      var multi;

      if (list) {
        list = multiBulkToStringArray(list);
        list.sort(peepSort);

        //Fetch individual user records.
        multi = redis.multi();
        list.forEach(function (id) {
          multi.hgetall(id);
        });
        multi.exec(function (err, hashes) {
          client.send(JSON.stringify({
            action: 'peepsResponse',
            items: hashes
          }));
        });
      } else {
        client.send(JSON.stringify({
          action: 'peepsResponse',
          items: []
        }));
      }
    });
  },

  'addPeep': function (data, client) {
    var peepId = data.peepId,
        userId = client._deuxUserId,
        multi;

    // Add the list to the data store
    redis.sadd('peeps:' + userId, peepId);

    // Get the peep ID and return it.
    multi = redis
              .multi()
              .hgetall(peepId)
              .exec(function (err, items) {
                client.send(JSON.stringify({
                  action: 'addPeepResponse',
                  peep: items[0]
                }));
              });
  },

  'removePeep': function (data, client) {
    var peepId = data.peepId,
        userId = client._deuxUserId;

    redis.srem('peeps:' + userId, peepId);
  },

  'startConversation': function (data, client) {
    //
    var args = data.args,
        from = args.from,
        to = args.to,
        message = args.message,
        time = (new Date()).getTime(),
        convId = args.from + '|' + args.to + '|' + time;

    // Create the meta data record
    redis.hmset(convId + '-meta', 'id', convId, 'from', from, 'to', to);

    // Create the list of participants
    redis.sadd(convId + '-peeps', from);
    redis.sadd(convId + '-peeps', to);


//TODO: Add converstaion ID to list of conversations for each user, but scoped
//to the sender?


    // Add the message to the message list for the conversation.
    redis.sadd(convId + '-messages', JSON.stringify(message));

    client.send(JSON.stringify({
      action: 'message',
      message: {
        convId: convId,
        from: from,
        text: message,
        time: time
      }
    }));
  },

  'message': function (data, client) {
    var convId = data.convId,
        conv;

    if (convCache[convId]) {

    } else {

    }


  }

};

server = http.createServer(function (req, res) {
  //Normal HTTP server stuff
  var ip = req.connection.remoteAddress;
  paperboy
    .deliver(path.join(__dirname, '..'), req, res)
    .addHeader('Expires', 300)
    .error(function (statCode, msg) {
      res.writeHead(statCode, {'Content-Type': 'text/plain'});
      res.end("Error " + statCode);
      console.log(statCode, req.url, ip, msg);
    })
    .otherwise(function (err) {
      res.writeHead(404, {'Content-Type': 'text/plain'});
      res.end("Error 404: File not found");
      console.log(404, req.url, ip, err);
    });
});

server.listen(8888);

listener = io.listen(server, {
  transports: ['websocket', 'htmlfile', 'xhr-multipart', 'xhr-polling', 'jsonp-polling']
});

listener.on('connection', function (client) {
  //client.send({ buffer: buffer });
  //client.broadcast({ announcement: client.sessionId + ' connected' });

  client.on('message', function (message) {
    message = JSON.parse(message);

    actions[message.action](message, client);
    //client.broadcast(msg);
  });

  client.on('disconnect', function () {
    actions.disconnect({}, client);
  });
});
