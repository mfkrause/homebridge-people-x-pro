class PeopleProAllAccessory {
  constructor(log, config, name, platform, peopleType) {
    this.log = log;
    this.config = config;
    this.name = name;
    this.type = 'motion';
    if (typeof config[`${peopleType}SensorType`] !== 'undefined' && config[`${peopleType}SensorType`] !== null) {
      if (typeof config[`${peopleType}SensorType`] !== 'string' || (config[`${peopleType}SensorType`] !== 'motion' && config[`${peopleType}SensorType`] !== 'occupancy')) {
        log(`Type "${config[`${peopleType}SensorType`]}" for sensor ${this.name} is invalid. Defaulting to "motion".`);
      } else {
        this.type = config[`${peopleType}SensorType`];
      }
    }
    this.platform = platform;

    if (this.type === 'motion') {
      this.service = new Service.MotionSensor(this.name);
      this.service
        .getCharacteristic(Characteristic.MotionDetected)
        .on('get', this.getState.bind(this));

      this.accessoryService = new Service.AccessoryInformation();
      this.accessoryService
        .setCharacteristic(Characteristic.Name, this.name)
        .setCharacteristic(Characteristic.SerialNumber, (this.name === this.platform.nooneSensorName) ? 'hps-noone' : 'hps-all')
        .setCharacteristic(Characteristic.Manufacturer, 'Elgato');
    } else {
      this.service = new Service.OccupancySensor(this.name);
      this.service
        .getCharacteristic(Characteristic.OccupancyDetected)
        .on('get', this.getState.bind(this));

      this.accessoryService = new Service.AccessoryInformation();
      this.accessoryService
        .setCharacteristic(Characteristic.Name, this.name);
    }
  }

  /**
   * Encodes a given bool state
   * @param {bool} state The state as a bool
   * @returns {object} The state as a Characteristic or int
   */
  encodeState(state) {
    if (this.type === 'motion') {
      if (state) return 1;
      return 0;
    }
    if (this.type === 'occupancy') {
      if (state) return Characteristic.OccupancyDetected.OCCUPANCY_DETECTED;
      return Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
    }
    return null;
  }

  /**
   * Gets the current state
   * @param {function} callback Function to callback with the current state
   */
  getState(callback) {
    callback(null, this.encodeState(this.getStateFromCache()));
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
   * Gets the current state for this accessory as a bool from the cache
   * @returns {bool} The current state of this accessory
   */
  getStateFromCache() {
    const isAnyoneActive = this.getAnyoneStateFromCache();
    if (this.name === this.platform.nooneSensorName) {
      return !isAnyoneActive;
    }
    return isAnyoneActive;
  }

  /**
   * Looks up if anyone is currently active from the cache
   * @returns {bool} True if anyone is active, false if no one is active
   */
  getAnyoneStateFromCache() {
    for (let i = 0; i < this.platform.peopleProAccessories.length; i += 1) {
      const peopleProAccessory = this.platform.peopleProAccessories[i];
      const isActive = peopleProAccessory.stateCache;
      if (isActive) {
        return true;
      }
    }
    return false;
  }

  /**
   * Refreshes the state of the sensor
   */
  refreshState() {
    if (this.type === 'motion') {
      this.service.getCharacteristic(Characteristic.MotionDetected)
        .updateValue(this.encodeState(this.getStateFromCache()));
    } else {
      this.service.getCharacteristic(Characteristic.OccupancyDetected)
        .updateValue(this.encodeState(this.getStateFromCache()));
    }
  }

  getServices() {
    return [this.service, this.accessoryService];
  }
}

module.exports = PeopleProAllAccessory;
