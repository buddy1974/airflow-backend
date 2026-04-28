import { AlertLevel } from '@prisma/client';

export interface AlertDetail {
  parameter:     string;
  wert:          string;
  schwellenwert: string;
  alertLevel:    AlertLevel;
}

export interface AlertResult {
  alertLevel:     AlertLevel;
  alertTriggered: boolean;
  alerts:         AlertDetail[];
}

interface VitalInput {
  spo2:          number;
  herzfrequenz:  number;
  atemfrequenz:  number;
  blutdruckSys:  number;
  temperatur:    number;
  spitzendruck?: number | null;
}

export function checkAlerts(data: VitalInput): AlertResult {
  const alerts: AlertDetail[] = [];

  function evaluate(
    parameter: string,
    value:     number,
    gelbLow:   number | null,
    gelbHigh:  number | null,
    rotLow:    number | null,
    rotHigh:   number | null
  ): void {
    if (rotLow !== null && value < rotLow) {
      alerts.push({ parameter, wert: String(value), schwellenwert: `< ${rotLow}`, alertLevel: AlertLevel.ROT });
    } else if (rotHigh !== null && value > rotHigh) {
      alerts.push({ parameter, wert: String(value), schwellenwert: `> ${rotHigh}`, alertLevel: AlertLevel.ROT });
    } else if (gelbLow !== null && value < gelbLow) {
      alerts.push({ parameter, wert: String(value), schwellenwert: `< ${gelbLow}`, alertLevel: AlertLevel.GELB });
    } else if (gelbHigh !== null && value > gelbHigh) {
      alerts.push({ parameter, wert: String(value), schwellenwert: `> ${gelbHigh}`, alertLevel: AlertLevel.GELB });
    }
  }

  evaluate('spo2',         data.spo2,         94,   null, 90,   null);
  evaluate('herzfrequenz', data.herzfrequenz,  50,   120,  40,   140);
  evaluate('atemfrequenz', data.atemfrequenz,  10,   25,   8,    30);
  evaluate('blutdruckSys', data.blutdruckSys,  90,   160,  80,   180);
  evaluate('temperatur',   data.temperatur,    36.0, 38.5, 35.0, 39.5);

  if (data.spitzendruck != null) {
    evaluate('spitzendruck', data.spitzendruck, null, 30, null, 35);
  }

  const hasRot  = alerts.some(a => a.alertLevel === AlertLevel.ROT);
  const hasGelb = alerts.some(a => a.alertLevel === AlertLevel.GELB);

  return {
    alertLevel:     hasRot ? AlertLevel.ROT : hasGelb ? AlertLevel.GELB : AlertLevel.GRUEN,
    alertTriggered: alerts.length > 0,
    alerts,
  };
}
