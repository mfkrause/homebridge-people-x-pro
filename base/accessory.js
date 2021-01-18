const ping = require('ping');
const moment = require('moment');
const arp = require('node-arp');

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
    .on('get', (callback) => {
      callback(null, 4);
    });

  this.service.addCharacteristic(DurationCharacteristic);
  this.service
    .getCharacteristic(DurationCharacteristic)
    .on('get', (callback) => {
      callback(null, 5);
    });

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

PeopleProAccessory.encodeState = (state) => {
  if (state) return Characteristic.OccupancyDetected.OCCUPANCY_DETECTED;
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
  this.log(`Identify: ${this.name}`);
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
      arp(this.target, (err, mac) => {
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
      });
    } else {
      ping.sys.probe(this.target, (state) => {
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
      });
    }
  } else {
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
  if (oldState !== newState) {
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

module.exports = PeopleProAccessory;
