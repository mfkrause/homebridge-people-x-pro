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

module.exports = LastActivationCharacteristic;
