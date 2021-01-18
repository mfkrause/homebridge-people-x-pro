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

module.exports = SensitivityCharacteristic;
