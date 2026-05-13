export type JobName =
  | 'FOOD DELIVERY'
  | 'AUTO PARTS RUN'
  | 'PACKAGE COURIER'
  | 'PARAMEDIC'
  | 'TOW TRUCK'
  | 'TRAFFIC COP'
  | 'TRUCK DRIVER'
  | 'FUEL TANKER'
  | 'OFFICE JOB';

export const JOB_BASE_PAY: Record<JobName, number> = {
  'FOOD DELIVERY':   0,
  'AUTO PARTS RUN':  77,
  'PACKAGE COURIER': 192,
  'PARAMEDIC':       135,
  'TOW TRUCK':       115,
  'TRAFFIC COP':     115,
  'TRUCK DRIVER':    154,
  'FUEL TANKER':     231,
  'OFFICE JOB':      154,
};

export const JOB_SALARY: Record<JobName, number> = {
  'FOOD DELIVERY':   0,
  'AUTO PARTS RUN':  77,
  'PACKAGE COURIER': 192,
  'PARAMEDIC':       135,
  'TOW TRUCK':       115,
  'TRAFFIC COP':     115,
  'TRUCK DRIVER':    154,
  'FUEL TANKER':     231,
  'OFFICE JOB':      154,
};

export const JOB_PAY_CAP: Record<JobName, number> = {
  'FOOD DELIVERY':   1.5,
  'AUTO PARTS RUN':  1.494,
  'PACKAGE COURIER': 1.203,
  'PARAMEDIC':       1.281,
  'TOW TRUCK':       1.339,
  'TRAFFIC COP':     1.339,
  'TRUCK DRIVER':    1.5,
  'FUEL TANKER':     1.333,
  'OFFICE JOB':      2.0,
};

export const JOB_VEHICLES: Partial<Record<JobName, string>> = {
  'PARAMEDIC':       'ambulance',
  'TOW TRUCK':       'tow_truck',
  'TRAFFIC COP':     'police_cruiser',
  'TRUCK DRIVER':    'semi_truck',
  'FUEL TANKER':     'semi_truck',
  'PACKAGE COURIER': 'box_truck',
};
