const PeopleProAccessory = require('./accessory');

const SENSOR_NOONE = 'No One';

class PeopleProAllAccessory {
  constructor(log, name, platform) {
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

  getState(callback) {
    callback(null, PeopleProAccessory.encodeState(this.getStateFromCache()));
  }

  identify(callback) {
    this.log(`Identify: ${this.name}`);
    callback();
  }

  getStateFromCache() {
    const isAnyoneActive = this.getAnyoneStateFromCache();
    if (this.name === SENSOR_NOONE) {
      return !isAnyoneActive;
    }
    return isAnyoneActive;
  }

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

  refreshState() {
    this.service.getCharacteristic(Characteristic.OccupancyDetected)
      .updateValue(PeopleProAccessory.encodeState(this.getStateFromCache()));
  }

  getServices() {
    return [this.service, this.accessoryService];
  }
}

module.exports = PeopleProAllAccessory;
