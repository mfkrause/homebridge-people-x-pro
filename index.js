const ping = require('ping');
const moment = require('moment');
const http = require('http');
const url = require('url');
const arp = require('node-arp');

const SENSOR_ANYONE = 'Anyone';
const SENSOR_NOONE = 'No One';
let FakeGatoHistoryService;

let Service, Characteristic, HomebridgeAPI;
module.exports = function (homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  HomebridgeAPI = homebridge;
  // eslint-disable-next-line global-require
  FakeGatoHistoryService = require('fakegato-history')(homebridge);

  homebridge.registerPlatform('homebridge-people-pro', 'PeoplePro', PeopleProPlatform);
  homebridge.registerAccessory('homebridge-people-pro', 'PeopleProAccessory', PeopleProAccessory);
  homebridge.registerAccessory('homebridge-people-pro', 'PeopleProAllAccessory', PeopleProAllAccessory);
};

// #######################
// PeopleProPlatform
// #######################

function PeopleProPlatform(log, config) {
  this.log = log;
  this.threshold = config.threshold || 15;
  this.anyoneSensor = ((typeof (config.anyoneSensor) !== 'undefined' && config.anyoneSensor !== null) ? config.anyoneSensor : true);
  this.nooneSensor = ((typeof (config.nooneSensor) !== 'undefined' && config.nooneSensor !== null) ? config.nooneSensor : true);
  this.webhookPort = config.webhookPort || 51828;
  this.cacheDirectory = config.cacheDirectory || HomebridgeAPI.user.persistPath();
  this.pingInterval = config.pingInterval || 10000;
  this.pingUseArp = config.pingUseArp;
  this.ignoreReEnterExitSeconds = config.ignoreReEnterExitSeconds || 0;
  this.people = config.people;
  this.storage = require('node-persist');
  this.storage.initSync({ dir: this.cacheDirectory });
  this.webhookQueue = [];
}

PeopleProPlatform.prototype = {

  accessories: function (callback) {
    this.accessories = [];
    this.peopleProAccessories = [];
    for (let i = 0; i < this.people.length; i += 1) {
      const peopleProAccessory = new PeopleProAccessory(this.log, this.people[i], this);
      this.accessories.push(peopleProAccessory);
      this.peopleProAccessories.push(peopleProAccessory);
    }
    if (this.anyoneSensor) {
      this.peopleAnyOneAccessory = new PeopleProAllAccessory(this.log, SENSOR_ANYONE, this);
      this.accessories.push(this.peopleAnyOneAccessory);
    }
    if (this.nooneSensor) {
      this.peopleNoOneAccessory = new PeopleProAllAccessory(this.log, SENSOR_NOONE, this);
      this.accessories.push(this.peopleNoOneAccessory);
    }
    callback(this.accessories);

    this.startServer();
  },

  startServer: function () {
    //
    // HTTP webserver code influenced by benzman81's great
    // homebridge-http-webhooks homebridge plugin.
    // https://github.com/benzman81/homebridge-http-webhooks
    //

    // Start the HTTP webserver
    http.createServer((function (request, response) {
      const theUrl = request.url;
      const theUrlParts = url.parse(theUrl, true);
      const theUrlParams = theUrlParts.query;
      let body = [];
      request.on('error', (function (err) {
        this.log('WebHook error: %s.', err);
      }).bind(this)).on('data', function (chunk) {
        body.push(chunk);
      }).on('end', (function () {
        body = Buffer.concat(body).toString();

        response.on('error', function (err) {
          this.log('WebHook error: %s.', err);
        });

        response.statusCode = 200;
        response.setHeader('Content-Type', 'application/json');

        if (!theUrlParams.sensor || !theUrlParams.state) {
          response.statusCode = 404;
          response.setHeader('Content-Type', 'text/plain');
          const errorText = 'WebHook error: No sensor or state specified in request.';
          this.log(errorText);
          response.write(errorText);
          response.end();
        }
        else {
          const sensor = theUrlParams.sensor.toLowerCase();
          const newState = (theUrlParams.state == 'true');
          this.log(`Received hook for ${sensor} -> ${newState}`);
          const responseBody = {
            success: true,
          };
          for (let i = 0; i < this.peopleProAccessories.length; i += 1) {
            const peopleProAccessory = this.peopleProAccessories[i];
            var target = peopleProAccessory.target;
            if (peopleProAccessory.name.toLowerCase() === sensor) {
              this.clearWebhookQueueForTarget(target);
              this.webhookQueue.push({ 'target': target, 'newState': newState, 'timeoutvar': setTimeout((function () {
                this.runWebhookFromQueueForTarget(target);
              }).bind(this), peopleProAccessory.ignoreReEnterExitSeconds * 1000) });
              break;
            }
          }
          response.write(JSON.stringify(responseBody));
          response.end();
        }
      }).bind(this));
    }).bind(this)).listen(this.webhookPort);
    this.log("WebHook: Started server on port '%s'.", this.webhookPort);
  },

  clearWebhookQueueForTarget: function (target) {
    for (let i = 0; i < this.webhookQueue.length; i += 1) {
      const webhookQueueEntry = this.webhookQueue[i];
      if (webhookQueueEntry.target == target) {
        clearTimeout(webhookQueueEntry.timeoutvar);
        this.webhookQueue.splice(i, 1);
        break;
      }
    }
  },

  runWebhookFromQueueForTarget: function (target) {
    for (let i = 0; i < this.webhookQueue.length; i += 1) {
      const webhookQueueEntry = this.webhookQueue[i];
      if (webhookQueueEntry.target == target) {
        this.log('Running hook for ' + target + ' -> ' + webhookQueueEntry.newState);
        this.webhookQueue.splice(i, 1);
        this.storage.setItemSync('lastWebhook_' + target, Date.now());
        this.getPeopleProAccessoryForTarget(target).setNewState(webhookQueueEntry.newState);
        break;
      }
    }
  },

  getPeopleProAccessoryForTarget: function (target) {
    for (let i = 0; i < this.peopleProAccessories.length; i += 1) {
      const peopleProAccessory = this.peopleProAccessories[i];
      if (peopleProAccessory.target === target) {
        return peopleProAccessory;
      }
    }
    return null;
  },
};

// #######################
// PeopleProAccessory
// #######################

function PeopleProAccessory(log, config, platform) {
  this.log = log;
  this.name = config.name;
  this.target = config.target;
  this.platform = platform;
  this.threshold = config.threshold || this.platform.threshold;
  this.pingInterval = config.pingInterval || this.platform.pingInterval;
  this.ignoreReEnterExitSeconds = config.ignoreReEnterExitSeconds
                                  || this.platform.ignoreReEnterExitSeconds;
  this.stateCache = false;

  class LastActivationCharacteristic extends Characteristic {
    constructor() {
      super('LastActivation', 'E863F11A-079E-48FF-8F27-9C2605A29F52');
      this.setProps({
        format: Characteristic.Formats.UINT32,
        unit: Characteristic.Units.SECONDS,
        perms: [
          Characteristic.Perms.READ,
          Characteristic.Perms.NOTIFY,
        ],
      });
    }
  }

  class SensitivityCharacteristic extends Characteristic {
    constructor() {
      super('Sensitivity', 'E863F120-079E-48FF-8F27-9C2605A29F52');
      this.setProps({
        format: Characteristic.Formats.UINT8,
        minValue: 0,
        maxValue: 7,
        validValues: [0, 4, 7],
        perms: [
          Characteristic.Perms.READ,
          Characteristic.Perms.NOTIFY,
          Characteristic.Perms.WRITE,
        ],
      });
    }
  }

  class DurationCharacteristic extends Characteristic {
    constructor() {
      super('Duration', 'E863F12D-079E-48FF-8F27-9C2605A29F52');
      this.setProps({
        format: Characteristic.Formats.UINT16,
        unit: Characteristic.Units.SECONDS,
        minValue: 5,
        maxValue: 15 * 3600,
        validValues: [
          5, 10, 20, 30,
          1 * 60, 2 * 60, 3 * 60, 5 * 60, 10 * 60, 20 * 60, 30 * 60,
          1 * 3600, 2 * 3600, 3 * 3600, 5 * 3600, 10 * 3600, 12 * 3600, 15 * 3600,
        ],
        perms: [
          Characteristic.Perms.READ,
          Characteristic.Perms.NOTIFY,
          Characteristic.Perms.WRITE,
        ],
      });
    }
  }

  this.service = new Service.MotionSensor(this.name);
  this.service
    .getCharacteristic(Characteristic.MotionDetected)
    .on('get', this.getState.bind(this));

  this.service.addCharacteristic(LastActivationCharacteristic);
  this.service
    .getCharacteristic(LastActivationCharacteristic)
    .on('get', this.getLastActivation.bind(this));

  this.service.addCharacteristic(SensitivityCharacteristic);
  this.service
    .getCharacteristic(SensitivityCharacteristic)
    .on('get', function (callback) {
      callback(null, 4);
    }.bind(this));

  this.service.addCharacteristic(DurationCharacteristic);
  this.service
    .getCharacteristic(DurationCharacteristic)
    .on('get', function (callback) {
      callback(null, 5);
    }.bind(this));

  this.accessoryService = new Service.AccessoryInformation();
  this.accessoryService
    .setCharacteristic(Characteristic.Name, this.name)
    .setCharacteristic(Characteristic.SerialNumber, `hps-${this.name.toLowerCase()}`)
    .setCharacteristic(Characteristic.Manufacturer, 'Elgato');

  this.historyService = new FakeGatoHistoryService('motion', {
    displayName: this.name,
    log: this.log,
  },
  {
    storage: 'fs',
    disableTimer: true,
  });

  this.initStateCache();

  if (this.pingInterval > -1) {
    this.ping();
  }
}

PeopleProAccessory.encodeState = function (state) {
  if (state)
    return Characteristic.OccupancyDetected.OCCUPANCY_DETECTED;
  else
    return Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
};

PeopleProAccessory.prototype.getState = function (callback) {
  callback(null, PeopleProAccessory.encodeState(this.stateCache));
};

PeopleProAccessory.prototype.getLastActivation = function (callback) {
  const lastSeenUnix = this.platform.storage.getItemSync(`lastSuccessfulPing_${this.target}`);
  if (lastSeenUnix) {
    const lastSeenMoment = moment(lastSeenUnix).unix();
    callback(null, lastSeenMoment - this.historyService.getInitialTime());
  }
};

PeopleProAccessory.prototype.identify = function (callback) {
  this.log('Identify: ' + this.name);
  callback();
};

PeopleProAccessory.prototype.initStateCache = function () {
  const isActive = this.isActive();
  this.stateCache = isActive;
};

PeopleProAccessory.prototype.isActive = function () {
  const lastSeenUnix = this.platform.storage.getItemSync(`lastSuccessfulPing_${this.target}`);
  if (lastSeenUnix) {
    const lastSeenMoment = moment(lastSeenUnix);
    const activeThreshold = moment().subtract(this.threshold, 'm');
    return lastSeenMoment.isAfter(activeThreshold);
  }
  return false;
};

PeopleProAccessory.prototype.ping = function () {
  if (this.webhookIsOutdated()) {
    if (this.pingUseArp) {
      arp(this.target, function (err, mac) {
        let state = false;
        if (!err && /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(mac)) state = true;

        if (this.webhookIsOutdated()) {
          if (state) {
            this.platform.storage.setItemSync(`lastSuccessfulPing_${this.target}`, Date.now());
          }
          if (this.successfulPingOccurredAfterWebhook()) {
            const newState = this.isActive();
            this.setNewState(newState);
          }
        }
        setTimeout(PeopleProAccessory.prototype.ping.bind(this), this.pingInterval);
      }.bind(this));
    } else {
      ping.sys.probe(this.target, function (state) {
        if (this.webhookIsOutdated()) {
          if (state) {
            this.platform.storage.setItemSync(`lastSuccessfulPing_${this.target}`, Date.now());
          }
          if (this.successfulPingOccurredAfterWebhook()) {
            const newState = this.isActive();
            this.setNewState(newState);
          }
        }
        setTimeout(PeopleProAccessory.prototype.ping.bind(this), this.pingInterval);
      }.bind(this));
    }
  }
  else {
    setTimeout(PeopleProAccessory.prototype.ping.bind(this), this.pingInterval);
  }
};

PeopleProAccessory.prototype.webhookIsOutdated = function () {
  const lastWebhookUnix = this.platform.storage.getItemSync(`lastWebhook_${this.target}`);
  if (lastWebhookUnix) {
    const lastWebhookMoment = moment(lastWebhookUnix);
    const activeThreshold = moment().subtract(this.threshold, 'm');
    return lastWebhookMoment.isBefore(activeThreshold);
  }
  return true;
};

PeopleProAccessory.prototype.successfulPingOccurredAfterWebhook = function () {
  const lastSuccessfulPing = this.platform.storage.getItemSync(`lastSuccessfulPing_${this.target}`);
  if (!lastSuccessfulPing) {
    return false;
  }
  const lastWebhook = this.platform.storage.getItemSync(`lastWebhook_${this.target}`);
  if (!lastWebhook) {
    return true;
  }
  const lastSuccessfulPingMoment = moment(lastSuccessfulPing);
  const lastWebhookMoment = moment(lastWebhook);
  return lastSuccessfulPingMoment.isAfter(lastWebhookMoment);
};

PeopleProAccessory.prototype.setNewState = function (newState) {
  const oldState = this.stateCache;
  if (oldState != newState) {
    this.stateCache = newState;
    this.service.getCharacteristic(Characteristic.MotionDetected)
      .updateValue(PeopleProAccessory.encodeState(newState));

    if (this.platform.peopleAnyOneAccessory) {
      this.platform.peopleAnyOneAccessory.refreshState();
    }

    if (this.platform.peopleNoOneAccessory) {
      this.platform.peopleNoOneAccessory.refreshState();
    }

    let lastSuccessfulPingMoment = 'none';
    let lastWebhookMoment = 'none';
    const lastSuccessfulPing = this.platform.storage.getItemSync(`lastSuccessfulPing_${this.target}`);
    if (lastSuccessfulPing) {
      lastSuccessfulPingMoment = moment(lastSuccessfulPing).format();
    }
    const lastWebhook = this.platform.storage.getItemSync(`lastWebhook_${this.target}`);
    if (lastWebhook) {
      lastWebhookMoment = moment(lastWebhook).format();
    }

    this.historyService.addEntry({
      time: moment().unix(),
      status: (newState) ? 1 : 0,
    });
    this.log('Changed occupancy state for %s to %s. Last successful ping %s , last webhook %s .', this.target, newState, lastSuccessfulPingMoment, lastWebhookMoment);
  }
};

PeopleProAccessory.prototype.getServices = function () {
  const servicesList = [this.service];

  if (this.historyService) {
    servicesList.push(this.historyService);
  }
  if (this.accessoryService) {
    servicesList.push(this.accessoryService);
  }

  return servicesList;
};

// #######################
// PeopleProAllAccessory
// #######################

function PeopleProAllAccessory(log, name, platform) {
  this.log = log;
  this.name = name;
  this.platform = platform;

  this.service = new Service.OccupancySensor(this.name);
  this.service
    .getCharacteristic(Characteristic.OccupancyDetected)
    .on('get', this.getState.bind(this));

  this.accessoryService = new Service.AccessoryInformation();
  this.accessoryService
    .setCharacteristic(Characteristic.Name, this.name)
    .setCharacteristic(Characteristic.SerialNumber, (this.name === SENSOR_NOONE) ? 'hps-noone' : 'hps-all')
    .setCharacteristic(Characteristic.Manufacturer, 'Elgato');
}

PeopleProAllAccessory.prototype.getState = function (callback) {
  callback(null, PeopleProAccessory.encodeState(this.getStateFromCache()));
};

PeopleProAllAccessory.prototype.identify = function (callback) {
  this.log(`Identify: ${this.name}`);
  callback();
};

PeopleProAllAccessory.prototype.getStateFromCache = function () {
  const isAnyoneActive = this.getAnyoneStateFromCache();
  if (this.name === SENSOR_NOONE) {
    return !isAnyoneActive;
  }
  return isAnyoneActive;
};

PeopleProAllAccessory.prototype.getAnyoneStateFromCache = function () {
  for (let i = 0; i < this.platform.peopleProAccessories.length; i += 1) {
    const peopleProAccessory = this.platform.peopleProAccessories[i];
    const isActive = peopleProAccessory.stateCache;
    if (isActive) {
      return true;
    }
  }
  return false;
};

PeopleProAllAccessory.prototype.refreshState = function () {
  this.service.getCharacteristic(Characteristic.OccupancyDetected)
    .updateValue(PeopleProAccessory.encodeState(this.getStateFromCache()));
};

PeopleProAllAccessory.prototype.getServices = function () {
  return [this.service, this.accessoryService];
};
