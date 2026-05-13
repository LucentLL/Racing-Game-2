export interface ExitMarker {
  num: number;
  name: string;
  wx: number;
  wy: number;
}

export const EXIT_MARKERS: readonly ExitMarker[] = [
  { num: 1,  name: 'NC-49',          wx: 9948,  wy: 42796 },
  { num: 3,  name: 'Arrowood',       wx: 16185, wy: 36180 },
  { num: 4,  name: 'Steele Creek',   wx: 7767,  wy: 42119 },
  { num: 6,  name: 'West Blvd',      wx: 5888,  wy: 40615 },
  { num: 9,  name: 'Wilkinson Blvd', wx: 4686,  wy: 38587 },
  { num: 10, name: 'I-85',           wx: 7615,  wy: 21748 },
  { num: 12, name: 'Moores Chapel',  wx: 9044,  wy: 19419 },
  { num: 14, name: 'Mt Holly Rd',    wx: 10998, wy: 17163 },
  { num: 16, name: 'Brookshire',     wx: 13178, wy: 15132 },
  { num: 18, name: 'Oakdale',        wx: 15660, wy: 13178 },
  { num: 21, name: 'Harris Blvd',    wx: 19266, wy: 11224 },
  { num: 23, name: 'I-77',           wx: 23997, wy: 6338  },
  { num: 26, name: 'Prosperity',     wx: 26828, wy: 5360  },
  { num: 28, name: 'Mallard Creek',  wx: 29409, wy: 4984  },
  { num: 30, name: 'I-85',           wx: 37647, wy: 9572  },
  { num: 32, name: 'N Tryon',        wx: 36565, wy: 7767  },
  { num: 33, name: 'NC-49',          wx: 34486, wy: 6264  },
  { num: 36, name: 'Rocky River',    wx: 39312, wy: 13930 },
  { num: 39, name: 'Harrisburg',     wx: 39894, wy: 16561 },
  { num: 41, name: 'Albemarle Rd',   wx: 39312, wy: 22425 },
  { num: 43, name: 'NC-51',          wx: 36982, wy: 28514 },
  { num: 44, name: 'Fairview',       wx: 35318, wy: 31371 },
  { num: 47, name: 'Lawyers Rd',     wx: 33319, wy: 33925 },
  { num: 49, name: 'Idlewild',       wx: 31157, wy: 36105 },
  { num: 51, name: 'US-74',          wx: 28824, wy: 37910 },
  { num: 52, name: 'E John St',      wx: 26327, wy: 39038 },
  { num: 54, name: 'Weddington',     wx: 23499, wy: 40016 },
  { num: 57, name: 'Providence',     wx: 20997, wy: 40690 },
  { num: 59, name: 'Rea Rd',         wx: 18291, wy: 41218 },
  { num: 61, name: 'Johnston Rd',    wx: 15884, wy: 41594 },
  { num: 64, name: 'NC-51',          wx: 12352, wy: 42271 },
  { num: 65, name: 'South Blvd',     wx: 13554, wy: 41970 },
  { num: 67, name: 'I-77',           wx: 14157, wy: 41743 },
];
