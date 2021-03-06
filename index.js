var fs = require('fs');
var net = require('net');
var path = require('path');
var spawn = require('child_process').spawn;
var async = require('async');
var _ = require('underscore');
var resolve = require('resolve');
var autotarget = require('async-autotarget');

exports = module.exports = function depends_on(targets, tree) {
  var d = get_dependencies(tree);
  return d.get_ready(targets).bind(d);
};

// this must be called at module scope because tape's process.on('exit', …) handler calls process.exit()
// this is also why you should require('depends-on') before you require('tape')
process.on('exit', stop);

process.on('uncaughtException', function(err) {
  process.stderr.write(err.stack + '\n');
  stop(err);
  throw err;
});

process.on('SIGINT', function() {
  _.each(get_dependency.cache, function(what, name) {
    if (what.child) {
      what.child.kill('SIGINT');
    }
  });
  throw new Error('SIGINT');
});

function stop(reason) {
  _.each(get_dependency.cache, function(what, name) {
    what.kill(reason);
  });
};
module.exports.stop = stop; // TODO offer async stop method also

var get_dependencies = _.memoize(function(tree) {
  return new Dependencies(tree);
});

function find_dependencies() {
  return resolve.sync('dependencies', { 
    basedir: process.cwd(),
    moduleDirectory: 'tests', 
    extensions: ['.json', '.js'] 
  });  
}
module.exports.find = find_dependencies;

function Dependencies(tree) {
  if (tree) {
    this.dependencies = tree;
    this.cwd = tree._cwd || __dirname;
    delete tree._cwd;
  } else {
    this.source = find_dependencies();
    try {
      this.dependencies = require(this.source);
    } catch (e) {
      this.error = e;
    }
    // this.source is always a filepath so all paths in that file should be relative to its directory
    this.cwd = path.dirname(this.source);
  }
  this.targets = {};
}

Dependencies.prototype.get_ready = function(targets) {
  var self = this;

  if (this.error) {
    return function already(callback) {
      if (typeof callback === 'object' && callback.test) {
        self.test = callback;
        callback = function(err) {
          self.test.error(err, "No error has already occurred");
          self.test.end();
        };
      }
      callback(this.error);
    }
  }

  return function ready(callback) {
    var
      start = new Date().getTime(),
      names = [];

    if (typeof callback === 'object' && callback.test) {
      self.test = callback;
      callback = function(err) {
        self.test.error(err, "Dependencies start up after " + (new Date().getTime() - start) + " ms");
        self.test.end();
        if (err) {
          // good idea?
          throw err;
        }
      };
    } else {
      self.test = null;
    }

    _.each(self.dependencies, function(what, name) {
      what.depends = what.depends || [];

      // adjust paths relative to directory of dependencies.json
      if (what.stdout && what.stdout[0] !== '/') {
        what.stdout = path.resolve(self.cwd, what.stdout);
      }

      if (what.stderr && what.stderr[0] !== '/') {
        what.stderr = path.resolve(self.cwd, what.stderr);
      }

      if (!what.cwd || what.cwd[0] !== '/') {
        what.cwd = what.cwd || self.cwd;
        what.cwd = path.resolve(self.cwd, what.cwd);
      }

      // TODO validate existence
      var d = get_dependency(name, what, self.cwd);
      self.targets[name] = what.depends.concat([d.spawn.bind(d, self.test)]);
    });

    targets = targets || [];
    if (targets.length) {
      self.targets = autotarget(self.targets, targets);
    }

    async.auto(self.targets, function(err, results) {
      names = names.concat(_.keys(results));
      callback(err);
    });
  }
};

var get_dependency = _.memoize(function(name, what) {
  return new Dependency(name, what);
});

function Dependency(name, what) {
  this.name = name;
  this.what = what;
  this.child = null;
  this.spawned = false; // TODO explicit state machine <——
  this.error = null;
  this.test = null;
}

Dependency.prototype.kill = function(reason) {
  if (!this.child) {
    return;
  }
  if (!this.child._handle) {
    return;
  }
  if (this.child.signalCode || this.child.exitCode) {
    return;
  }
  if (reason) {
    process.stderr.write('Killing '+ this.name + " because " + reason + '\n');
  }
  if (!this.error) { // todo: don't kill if this.error ?
    this.error = this.name + " killed" + (reason ? " because " + reason : '');
  }  
  this.child.removeAllListeners('exit');
  this.child.kill(this.what.signal || 'SIGTERM');
};

Dependency.prototype.spawn = function(test, callback) {
  var
    self = this,
    cmd = this.what.cmd[0],
    args = this.what.cmd.slice(1);

  this.test = test;

  if (this.error) {
    if (test) {
      test.fail(this.error); // todo should this.error be set to null after use? need a state machine :/
    }
    _.defer(function() {
      callback(test ? null : self.error); // don't callback(self.error) if we called test.fail instead
    });
    return;
  }

  if (this.spawned) {
    if (test) {
      test.pass(this.name + " already started");
    }
    _.defer(callback);
    return;
  }
  this.spawned = true;

  this.child = spawn(cmd, args, {
    'cwd': this.what.cwd,
    'stdio': [ 0, 
      this.what.stdout && fs.openSync(this.what.stdout, 'a') || 1, 
      this.what.stderr && fs.openSync(this.what.stderr, 'a') || 2]
  });

  this.child.unref(); // don't block the event loop, children will be signalled on exit

  this.child.on('exit', function(code, signal) {
    if (self.what.wait_for && code == self.what.wait_for.exit_code) {
      return;
    }

    var msg;

    if (!_.isNull(code) && code !== 0) {
      msg = self.name + " exited with code " + code;
      self.error = new Error(msg);
    }

    if (msg) {
      if (test) {
        test.fail(msg);
      } else {
        process.stderr.write(msg + '\n');
      }
      stop(msg);
    }
  });

  if (this.what.wait_for) { // TODO should be subtypes of Dependency
    this.what.wait_for.timeout = this.what.wait_for.timeout || 30;
    if (this.what.wait_for.port) {
      this.waitOnSocket(callback);
    } else if (this.what.wait_for.exit_code !== undefined) {
      this.waitOnExit(callback);
    } else {
      throw new Error("`wait_for` is defined but has neither `port` nor `exit_code`!");
    }
    return;
  }

  // This lets us return an err to callback() if `cmd` exited non-zero somewhat immediately
  this.timer = setTimeout(function() {
    if (self.child.signalCode || self.child.exitCode) {
      if (self.waiter) {
        self.waiter.error();
      }
      if (self.child.signalCode) {
        self.error = new Error(self.name + " exited after signal " + self.child.signalCode);
      } else if (self.child.exitCode !== undefined) {
        self.error = new Error(self.name + " exited immediately with code " + self.child.exitCode);
      }
      if (test && self.error) {
        test.fail(self.error);
        callback(null, self.name);
        return;
      }
      callback(self.error, self.name);
      return;
    }
    if (test) {
      test.pass(self.name);
    }
    callback(null, self.name);
  }, 100); // one tick is not enough
};

Dependency.prototype.waitOnSocket = function(callback) {
  var
    self = this,
    found = false, // state machine?
    start = new Date().getTime();

  function retry(callback) {
    if (new Date().getTime() - start > self.what.wait_for.timeout * 1000) {
      callback(new Error("Timed out after "+ (new Date().getTime() - start) +" waiting for " + self.name));
      return;
    }
    if (found) {
      callback();
      return;
    }
    if (self.error) {
      callback(self.error);
      return;
    }
    return setTimeout(callback, 198);
  }

  callback = _.once(callback);

  async.until(function() {
    return found || this.error;
  }, function(callback) {
    var
      socket = net.connect(self.what.wait_for.port, self.what.wait_for.host),
      id = setTimeout(function() {
        socket.destroy();
        retry(callback);
      }, 199);

    socket.on('connect', function() {
      found = true;
      clearTimeout(id);
      socket.end();
      callback();
    });

    socket.on('error', function(err) {
      clearTimeout(id);
      id = retry(callback);
    });

  }, function(err) {
    if (self.test && !err) {
      self.test.pass(self.name +' started in '+ (new Date().getTime() - start) +'ms');
    }
    callback(err || this.error);
  });
};

// todo use an on('exit') handler
Dependency.prototype.waitOnExit = function(callback) {
  var
    self = this,
    last,
    start = new Date().getTime();

  callback = _.once(callback);
  async.until(function() {
    last = new Date().getTime() - start;
    return self.child.exitCode || (last > self.what.wait_for.timeout * 1000)
  }, function(callback) {
    _.delay(callback, 101);
  }, function(err) {
    if (err) { // unreachable?
      callback(err);
      return;
    }
    if (self.child.exitCode == self.what.wait_for.exit_code) {
      if (self.test) {
        self.test.pass(self.name +' started in '+ last);
      }
      callback();
      return;
    } else if (self.child.exitCode !== null) {
      callback(new Error("Expected " + self.name + " to exit " + self.what.wait_for.exit_code + " but got " + self.child.exitCode));
    } else {
      callback(new Error("Timed out after "+ (new Date().getTime() - start) +" waiting for " + self.name));
    }
  });
};

