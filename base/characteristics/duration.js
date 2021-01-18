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

module.exports = DurationCharacteristic;
