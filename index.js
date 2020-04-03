const defaultWriteConcern = {
  w: 1,
  j: true,
  wtimeout: 10240
};

const mongoErrorHandler = (error) => {
  if (error) {
    console.error('[josk] [mongoErrorHandler]:', error);
  }
};
const _debug = (...args) => {
  console.info.call(console, '[DEBUG] [josk]', ...args);
};
const prefixRegex = /set(Immediate|Timeout|Interval)$/;

const errors = {
  dbOption: {
    error: '{db} option is required',
    description: 'MongoDB database {db} option is required, e.g. returned from `MongoClient.connect` method'
  },
  setInterval: {
    delay: '[josk] [setInterval] delay must be positive Number!',
    uid: '[josk] [setInterval] [uid - task id must be specified (3rd argument)]'
  },
  setTimeout: {
    delay: '[josk] [setTimeout] delay must be positive Number!',
    uid: '[josk] [setTimeout] [uid - task id must be specified (3rd argument)]'
  },
  setImmediate: {
    uid: '[josk] [setImmediate] [uid - task id must be specified (2nd argument)]'
  }
};

module.exports = class JoSk {
  constructor(opts = {}) {
    this.prefix      = opts.prefix || '';
    this.onError     = opts.onError || false;
    this.autoClear   = opts.autoClear || false;
    this.zombieTime  = opts.zombieTime || 900000;
    this.onExecuted  = opts.onExecuted || false;
    this.resetOnInit = opts.resetOnInit || false;
    this.minRevolvingDelay = opts.minRevolvingDelay || 32;
    this.maxRevolvingDelay = opts.maxRevolvingDelay || 256;

    if (!opts.db) {
      if (this.onError) {
        this.onError(errors.dbOption.error, {
          description: errors.dbOption.description,
          error: errors.dbOption.error,
          uid: null
        });
      } else {
        _debug(`[constructor] ${errors.dbOption.description}`);
      }
      return;
    }

    this.collection = opts.db.collection(`__JobTasks__${this.prefix}`);
    this.collection.createIndex({uid: 1}, {background: false, unique: true}, (indexError) => {
      if (indexError) {
        _debug('[constructor] [createIndex] [uid]', indexError);
      }
    });

    this.collection.createIndex({executeAt: 1}, {background: false}, (indexError) => {
      if (indexError) {
        _debug('[constructor] [createIndex] [executeAt]', indexError);
      }
    });

    if (this.resetOnInit) {
      this.collection.deleteMany({
        isInterval: false
      }, mongoErrorHandler);
    }

    this.tasks = {};
    this.__setNext();
  }

  setInterval(func, delay, _uid) {
    let uid = _uid;

    if (delay < 0) {
      throw new Error(errors.setInterval.delay);
    }

    if (uid) {
      uid += 'setInterval';
    } else {
      throw new Error(errors.setInterval.uid);
    }

    this.tasks[uid] = func;
    this.__addTask(uid, true, delay);
    return uid;
  }

  setTimeout(func, delay, _uid) {
    let uid = _uid;

    if (delay < 0) {
      throw new Error(errors.setTimeout.delay);
    }

    if (uid) {
      uid += 'setTimeout';
    } else {
      throw new Error(errors.setTimeout.uid);
    }

    this.tasks[uid] = func;
    this.__addTask(uid, false, delay);
    return uid;
  }

  setImmediate(func, _uid) {
    let uid = _uid;

    if (uid) {
      uid += 'setImmediate';
    } else {
      throw new Error(errors.setImmediate.uid);
    }

    this.tasks[uid] = func;
    this.__addTask(uid, false, 0);
    return uid;
  }

  clearInterval() {
    return this.__clear.apply(this, arguments);
  }

  clearTimeout() {
    return this.__clear.apply(this, arguments);
  }

  __clear(uid) {
    this.collection.deleteOne({ uid }, defaultWriteConcern, (deleteError) => {
      this.__errorHandler(deleteError, '[__clear] [deleteOne] [deleteError]', 'Error in a callback of .deleteOne() method of .__clear()', uid);
    });

    if (this.tasks && this.tasks[uid]) {
      delete this.tasks[uid];
    }
    return true;
  }

  __addTask(uid, isInterval, delay) {
    this.collection.findOne({
      uid: uid
    }, (findError, task) => {
      if (findError) {
        this.__errorHandler(findError, '[__addTask] [findOne] [findError]', 'Error in a callback of .findOne() method of .__addTask()', uid);
      } else if (!task) {
        this.collection.insertOne({
          uid: uid,
          delay: delay,
          executeAt: new Date(Date.now() + delay),
          isInterval: isInterval
        }, (insertError) => {
          this.__errorHandler(insertError, '[__addTask] [insertOne] [insertError]', 'Error in a callback of .insertOne() method of .__addTask()', uid);
        });
      } else {
        let update = null;
        if (task.delay !== delay) {
          if (!update) {
            update = {};
          }
          update.delay = delay;
        }

        if (+task.executeAt > Date.now() + delay) {
          if (!update) {
            update = {};
          }
          update.executeAt = new Date(Date.now() + delay);
        }

        if (update) {
          this.collection.updateOne({
            uid: uid
          }, {
            $set: update
          }, (updateError) => {
            this.__errorHandler(updateError, '[__addTask] [updateOne] [updateError]', 'Error in a callback of .updateOne() method of .__addTask()', uid);
          });
        }
      }
    });
  }

  __execute(task) {
    const done = (_date) => {
      this.collection.updateOne({
        uid: task.uid
      }, {
        $set: {
          executeAt: _date
        }
      }, (updateError) => {
        this.__errorHandler(updateError, '[__execute] [done] [updateOne] [updateError]', 'Error in a callback of .updateOne() method of .__execute()', task.uid);
      });
    };

    if (this.tasks && this.tasks[task.uid]) {
      const ready = () => {
        const date = new Date();
        const timestamp = +date;

        if (task.isInterval === true) {
          done(new Date(timestamp + task.delay));
        }

        if (this.onExecuted) {
          this.onExecuted(task.uid.replace(prefixRegex, ''), {
            uid: task.uid,
            date: date,
            delay: task.delay,
            timestamp: timestamp
          });
        }
      };

      this.tasks[task.uid](ready);
      if (task.isInterval === false) {
        this.__clear(task.uid);
      }
    } else {
      done(new Date());
      if (this.autoClear) {
        this.__clear(task.uid);
        _debug(`[FYI] [${task.uid}] task was auto-cleared`);
      } else if (this.onError) {
        this.onError('One of your tasks is missing', {
          description: `Something went wrong with one of your tasks - is missing.
            Try to use different instances.
            It's safe to ignore this message.
            If this task is obsolete - simply remove it with \`JoSk#clearTimeout('${task.uid}')\`,
            or enable autoClear with \`new JoSk({autoClear: true})\``,
          error: null,
          uid: task.uid
        });
      } else {
        _debug(`[__execute] [${task.uid}] Something went wrong with one of your tasks is missing.
          Try to use different instances.
          It's safe to ignore this message.
          If this task is obsolete - simply remove it with \`JoSk#clearTimeout(\'${task.uid}\')\`,
          or enable autoClear with \`new JoSk({autoClear: true})\``);
      }
    }
  }

  __runTasks() {
    const _date = new Date();
    try {
      this.collection.findOneAndUpdate({
        executeAt: {
          $lte: _date
        }
      }, {
        $set: {
          executeAt: new Date(+_date + this.zombieTime)
        }
      }, defaultWriteConcern, (findUpdateError, task) => {
        this.__setNext();
        if (findUpdateError) {
          this.__errorHandler(findUpdateError, '[__runTasks] [findOneAndUpdate] [findUpdateError]', 'Error in a callback of .findOneAndUpdate() method of .__runTasks()', null);
        } else if (task.value) {
          this.__execute(task.value);
        }
      });
    } catch (_error) {
      this.__setNext();
      this.__errorHandler(_error, '[__runTasks] [catch]', 'General Error during runtime in try-catch block of __runTasks()', null);
    }
  }

  __setNext() {
    setTimeout(this.__runTasks.bind(this), Math.round((Math.random() * this.maxRevolvingDelay) + this.minRevolvingDelay));
  }

  __errorHandler(error, title, description, uid) {
    if (error) {
      if (this.onError) {
        this.onError(title, { description, error, uid });
      } else {
        mongoErrorHandler(error);
      }
    }
  }
};
