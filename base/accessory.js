const ping = require('ping');
const moment = require('moment');
const arp = require('node-arp');

const {
  LastActivationCharacteristic,
  SensitivityCharacteristic,
  DurationCharacteristic,
} = require('./characteristics');

class PeopleProAccessory {
  constructor(log, config, platform) {
    this.log = log;
    this.name = config.name;
    this.target = config.target;
    this.excludedFromWebhook = config.excludedFromWebhook;
    this.platform = platform;
    this.threshold = config.threshold || this.platform.threshold;
    this.pingInterval = config.pingInterval || this.platform.pingInterval;
    this.stateCache = false;
    this.pingUseArp = ((typeof (config.pingUseArp) !== 'undefined' && config.pingUseArp !== null) ? config.pingUseArp : false);

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
      this.pingFunction();
    }
  }

  /**
   * Encodes a given bool state and returns it back as a Characteristic
   * @param {bool} state The state as a bool
   * @returns {object} The state as a Characteristic
   */
  static encodeState(state) {
    if (state) return Characteristic.OccupancyDetected.OCCUPANCY_DETECTED;
    return Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }

  /**
   * Gets the current state from the cache
   * @param {function} callback The function to callback with the current state
   */
  getState(callback) {
    callback(null, PeopleProAccessory.encodeState(this.stateCache));
  }

  /**
   * Gets the date of the last activation / successful ping of this sensor
   * @param {function} callback The function to callback with the last activation time
   */
  getLastActivation(callback) {
    const lastSeenUnix = this.platform.storage.getItemSync(`lastSuccessfulPing_${this.target}`);
    if (lastSeenUnix) {
      const lastSeenMoment = moment(lastSeenUnix).unix();
      callback(null, lastSeenMoment - this.historyService.getInitialTime());
    }
  }

  /**
   * Identifies / logs the name of this accessory
   * @param {function} callback Fnction to callback once finished
   */
  identify(callback) {
    this.log(`Identify: ${this.name}`);
    callback();
  }

  /**
   * Initiates the state cache with the current state
   */
  initStateCache() {
    const isActive = this.isActive();
    this.stateCache = isActive;
  }

  /**
   * Checks if the target of this accessory/sensor is currently active based on last successful ping
   * and configured threshold
   * @returns {bool} True if the target is currently active, false if not
  */
  isActive() {
    const lastSeenUnix = this.platform.storage.getItemSync(`lastSuccessfulPing_${this.target}`);
    if (lastSeenUnix) {
      const lastSeenMoment = moment(lastSeenUnix);
      const activeThreshold = moment().subtract(this.threshold, 'm');
      return lastSeenMoment.isAfter(activeThreshold);
    }
    return false;
  }

  /**
   * Pings or, if configured, ARP lookups the target of this accessory/sensor and updated the state
   * accordingly. Gets called on a regular basis through an interval at the configured interval time
   */
  pingFunction() {
    if (this.webhookIsOutdated()) {
      if (this.pingUseArp) {
        arp.getMAC(this.target, (err, mac) => {
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
          setTimeout(this.pingFunction.bind(this), this.pingInterval);
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
          setTimeout(this.pingFunction.bind(this), this.pingInterval);
        });
      }
    } else {
      setTimeout(this.pingFunction.bind(this), this.pingInterval);
    }
  }

  /**
   * Checks if the last received webhook is outdated based on the configured threshold
   * @returns {bool} True if the webhook is outdated, false if it is not
   */
  webhookIsOutdated() {
    const lastWebhookUnix = this.platform.storage.getItemSync(`lastWebhook_${this.target}`);
    if (lastWebhookUnix) {
      const lastWebhookMoment = moment(lastWebhookUnix);
      const activeThreshold = moment().subtract(this.threshold, 'm');
      return lastWebhookMoment.isBefore(activeThreshold);
    }
    return true;
  }

  /**
   * Checks if the last successful ping occured after the last webhook
   * @returns {bool} True if the last successful ping occured after the last webhook, false if
   * it did not
   */
  successfulPingOccurredAfterWebhook() {
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
  }

  /**
   * Updates the state of the sensor and adds to the fakegato history
   * @param {bool} newState The new state as a bool
   */
  setNewState(newState) {
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
      if (this.pingUseArp) {
        this.log('Changed occupancy state for %s to %s. Last successful arp lookup %s , last webhook %s .', this.target, newState, lastSuccessfulPingMoment, lastWebhookMoment);
      } else {
        this.log('Changed occupancy state for %s to %s. Last successful ping %s , last webhook %s .', this.target, newState, lastSuccessfulPingMoment, lastWebhookMoment);
      }
    }
  }

  getServices() {
    const servicesList = [this.service];

    if (this.historyService) {
      servicesList.push(this.historyService);
    }
    if (this.accessoryService) {
      servicesList.push(this.accessoryService);
    }

    return servicesList;
  }
}

module.exports = PeopleProAccessory;
