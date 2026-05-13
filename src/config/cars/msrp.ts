/**
 * Hand-priced 1999-era USD MSRPs for highest-visibility cars in the catalog.
 * Keys are the EXACT name string from GT4_DB so lookups are unambiguous.
 *
 * JDM-only models list gray-market import prices a US buyer would have paid in 1999.
 * Classics (<1980) show 1999 collector values, not original MSRPs.
 * Race cars show hypothetical private-buyer/collector values since most were never sold retail.
 */
export const CAR_MSRP: Record<string, number> = {
  // Honda / Acura
  'Honda CIVIC 1500 3door CX `79': 5500,
  'Honda CIVIC 1500 3door 25i `83': 7800,
  'Honda CR-X SiR `90': 14200,
  'Honda CR-X del Sol SiR `92': 16500,
  'Honda CIVIC SiR-II (EG) `91': 15500,
  'Honda CIVIC SiR-II (EG) `92': 16000,
  'Honda CIVIC SiR-II (EG) `93': 16400,
  'Honda CIVIC SiR-II (EG) `95': 16800,
  'Honda CIVIC TYPE R (EK) `97': 19500,
  'Honda CIVIC TYPE R (EK) `98': 20000,
  'Honda INTEGRA TYPE R (DC2) `95': 24000,
  'Honda INTEGRA TYPE R (DC2) `98': 25700,
  'Honda INTEGRA TYPE R (DC2) `99': 26000,
  'Spoon INTEGRA TYPE R (DC2) `99': 38000,
  'Honda PRELUDE Si VTEC `91': 21500,
  'Honda PRELUDE SiR `96': 24000,
  'Honda PRELUDE SiR S spec `98': 25800,
  'Honda PRELUDE Type S `96': 24800,
  'Honda PRELUDE Type S `98': 26500,
  'Honda S2000 `99': 32000,
  'Honda NSX `90': 62000,
  'Honda NSX `93': 68000,
  'Honda NSX `95': 75000,
  'Honda NSX `97': 84000,
  'Honda NSX `99': 88000,
  'Honda NSX Type R `92': 95000,
  'Honda NSX Type S `97': 92000,
  'Honda NSX Type S `99': 95000,
  'Honda NSX Type S Zero `97': 108000,
  'Honda NSX Type S Zero `99': 112000,
  'Honda BEAT `91': 10500,
  'Honda BEAT Version F `92': 11000,
  'Honda BEAT Version Z `93': 11500,
  'Honda Insight `99': 20000,
  'Honda ACCORD Coupe `88': 12500,
  'Honda BALLADE SPORTS CR-X 1.5i `83': 9800,
  'Honda CITY Turbo II `83': 10500,
  'Acura NSX `91': 60000,
  'Acura NSX Coupe `97': 84000,

  // Toyota
  'Toyota SUPRA RZ `97': 42000,
  'Toyota SUPRA SZ-R `97': 32000,
  'Toyota SUPRA 3.0GT Turbo A `88': 26000,
  'Toyota SUPRA 2.5GT Twin Turbo R `90': 29500,
  'Toyota MR2 G-Limited `97': 25000,
  'Toyota MR2 GT-S `97': 27500,
  'Toyota MR2 Spyder `99': 24000,
  'Toyota MR2 1600 G `86': 13500,
  'Toyota MR2 1600 G-Limited Super Charger `86': 15000,
  'Toyota CELICA GT-FOUR (ST205) `98': 31000,
  'Toyota CELICA GT-FOUR RC (ST185) `91': 26500,
  'Toyota CELICA SS-II (ST202) `97': 21500,
  'Toyota CELICA SS-II (ZZT231) `99': 21500,
  'Toyota CELICA 2000GT-FOUR (ST165) `86': 22000,
  'Toyota CELICA XX 2800GT `81': 15500,
  'Toyota COROLLA LEVIN GT-APEX (AE86) `83': 8800,
  'Toyota SPRINTER TRUENO GT-APEX (AE86) `83': 8800,
  'Toyota COROLLA LEVIN BZ-R `98': 18000,
  'Toyota SPRINTER TRUENO BZ-R `98': 18000,
  'Toyota 2000GT `67': 250000,
  'Toyota STARLET Glanza V `97': 13500,
  'Toyota VITZ F `99': 10000,
  'Toyota SERA `92': 13000,

  // Nissan
  'Nissan SKYLINE GT-R (R32) `89': 32000,
  'Nissan SKYLINE GT-R (R32) `91': 34000,
  'Nissan SKYLINE GT-R Vspec (R32) `93': 38000,
  'Nissan SKYLINE GT-R Vspec II (R32) `94': 40000,
  'Nissan SKYLINE GT-R Vspec N1 (R32) `93': 45000,
  'Nissan SKYLINE GT-R N1 (R32) `91': 42000,
  'Nissan SKYLINE GT-R (R33) `95': 42000,
  'Nissan SKYLINE GT-R (R33) `96': 43000,
  'Nissan SKYLINE GT-R (R33) `97': 44000,
  'Nissan SKYLINE GT-R Vspec (R33) `95': 45000,
  'Nissan SKYLINE GT-R Vspec (R33) `96': 46000,
  'Nissan SKYLINE GT-R Vspec (R33) `97': 47000,
  'Nissan SKYLINE GT-R Vspec LM Limited (R33) `96': 52000,
  'Nissan SKYLINE GT-R N1 (R33) `95': 50000,
  'Nissan SKYLINE GT-R (R34) `99': 55000,
  'Nissan SKYLINE GT-R V-spec (R34) `99': 58000,
  'Nissan SKYLINE GT-R V-spec N1 (R34) `99': 62000,
  'Nissan SKYLINE GT-R Special Color Midnight Purple II (R34) `99': 62000,
  'NISMO Skyline GT-R R-tune (R34) `99': 85000,
  "Nissan SILVIA K's (S13) `88": 12500,
  "Nissan SILVIA K's (S13) `91": 14000,
  "Nissan SILVIA Q's (S13) `88": 10500,
  "Nissan SILVIA Q's (S13) `91": 11500,
  "Nissan SILVIA K's AERO (S14) `93": 17500,
  "Nissan SILVIA Q's AERO (S14) `93": 14000,
  "Nissan SILVIA Q's AERO (S14) `96": 14500,
  'Nissan SILVIA Spec R AERO (S15) `99': 22000,
  'Nissan SILVIA Spec S AERO (S15) `99': 17500,
  'Nissan 240SX `96': 17000,
  'Nissan 240SX (S14) `96': 18500,
  'SILEIGHTY `98': 18000,
  'Nissan 300ZX 2seater (Z32) `89': 30000,
  'Nissan 300ZX 2seater (Z32) `98': 36000,
  'Nissan 300ZX 2by2 (Z32) `98': 38000,

  // Mazda
  'Mazda RX-7 Type R (FD, J) `91': 32000,
  'Mazda RX-7 Type R (FD, J) `93': 33500,
  'Mazda RX-7 Type R-S (FD, J) `95': 35000,
  'Mazda RX-7 Type RS (FD, J) `96': 36000,
  'Mazda RX-7 Type RS-R (FD) `97': 38000,
  'Mazda RX-7 Type RS (FD) `98': 39000,
  'Mazda RX-7 Type RZ (FD, J) `92': 37000,
  'Mazda RX-7 Type RZ (FD, J) `93': 38000,
  'Mazda RX-7 Type RZ (FD, J) `95': 39000,
  'Mazda RX-7 Type RZ (FD, J) `96': 40000,
  'Mazda RX-7 GT-Limited (FC, J) `85': 13500,
  'Mazda RX-7 GT-X (FC, J) `90': 17000,
  'Mazda RX-7 INFINI III (FC, J) `90': 18500,
  'Mazda MX-5 Miata (NA) `89': 14500,
  'Mazda MX-5 Miata J-Limited (NA, J) `91': 15200,
  'Mazda MX-5 Miata J-Limited II (NA, J) `93': 16000,
  'Mazda MX-5 Miata V-Special Type II (NA, J) `93': 16500,
  'Mazda MX-5 Miata S-Special Type I (NA, J) `95': 16500,
  'Mazda MX-5 Miata VR-Limited (NA, J) `95': 17000,
  'Mazda MX-5 Miata SR-Limited (NA, J) `97': 17500,
  'Mazda MX-5 Miata 1.8 RS (NB, J) `98': 20500,
  'Mazda Autozam AZ-1 `92': 11500,
  'Mazda DEMIO (J) `99': 11000,
  'Mazda Mazda 323F `93': 12000,
  'Mazda 787B Race Car `91': 450000,

  // Mitsubishi
  'Mitsubishi Lancer Evolution GSR `92': 24000,
  'Mitsubishi Lancer Evolution II GSR `94': 26500,
  'Mitsubishi Lancer Evolution III GSR `95': 28500,
  'Mitsubishi Lancer Evolution IV GSR `96': 30000,
  'Mitsubishi Lancer Evolution V GSR `98': 32000,
  'Mitsubishi Lancer Evolution VI GSR `99': 33500,
  'Mitsubishi Lancer Evolution VI RS `99': 31000,
  'Mitsubishi 3000GT VR-4 (J) `98': 45000,
  'Mitsubishi 3000GT VR-4 Turbo (J) `95': 43000,
  'Mitsubishi 3000GT VR-4 Turbo (J) `96': 44000,
  'Mitsubishi 3000GT SL (J) `95': 30000,
  'Mitsubishi 3000GT SL (J) `96': 31000,
  'Mitsubishi 3000GT SL (J) `98': 33000,
  'Mitsubishi 3000GT MR (J) `95': 40000,
  'Mitsubishi 3000GT MR (J) `98': 42000,
  'Mitsubishi FTO GPX `94': 19500,
  'Mitsubishi FTO GPX `97': 21000,
  'Mitsubishi FTO GPX `99': 22000,
  'Mitsubishi FTO GP Version R `97': 22500,
  'Mitsubishi FTO GP Version R `99': 23500,
  'Mitsubishi FTO GR `94': 16500,
  'Mitsubishi FTO GR `97': 17500,

  // Subaru
  'Subaru IMPREZA Sedan WRX STi (GC) `94': 19500,
  'Subaru IMPREZA Sedan WRX STi Version II (GC) `95': 22500,
  'Subaru IMPREZA Sedan WRX STi Version III (GC) `96': 24000,
  'Subaru IMPREZA Sedan WRX STi Version IV (GC) `97': 26500,
  'Subaru IMPREZA Sedan WRX STi Version V (GC) `98': 27500,
  'Subaru IMPREZA Sedan WRX STi Version VI (GC) `99': 28500,
  'Subaru IMPREZA Coupe WRXtypeR STi Version VI (GC) `99': 30000,
  'Subaru IMPREZA Sport Wagon WRX STi Version VI (GF) `99': 29500,
  'Subaru IMPREZA Premium Sport Coupe 22B-STi Version (GC) `98': 42000,
  'Subaru LEGACY B4 RSK `98': 25500,
  'Subaru LEGACY Touring Wagon GT-B `96': 22000,

  // BMW / Euro
  'BMW M Coupe `98': 42000,
  'BMW 2002 Turbo `73': 18500,
  'Aston Martin V8 Vantage `99': 285000,
  'Audi quattro `82': 16000,
  'Audi S4 `98': 38500,

  // RUF
  'RUF CTR2 `96': 235000,

  // American muscle / classic (1999 collector values)
  'Shelby Cobra 427 `67': 215000,
  'Shelby Mustang G.T. 350R `65': 180000,
  'AC Cars 427 S/C `66': 200000,
  'Chevrolet Camaro SS `69': 30000,
  'Chevrolet Camaro Z28 302 `69': 28000,
  'Chevrolet Chevelle SS 454 `70': 38000,
  'Chevrolet Corvette Convertible (C1) `54': 55000,
  'Chevrolet Corvette Coupe (C2) `63': 42000,
  'Chevrolet Corvette Stingray L46 350 (C3) `69': 26000,
  'Chevrolet Corvette GRAND SPORT (C4) `96': 45000,
  'Chevrolet Corvette ZR-1 (C4) `90': 38000,
  'Chevrolet Camaro Z28 Coupe `97': 22000,
  'Chevrolet Camaro IROC-Z Concept `88': 18500,
  'Dodge Charger 440 R/T `70': 28000,
  'Dodge Charger Super Bee 426 Hemi `71': 35000,
  'Dodge VIPER GTS `99': 72000,
  'Plymouth Super Bird `70': 85000,
  'Plymouth Cuda 440 Six Pack `71': 38000,
  'Pontiac Tempest Le Mans GTO `64': 26000,
  'Ford Taurus SHO `98': 23000,
  'Ford RS200 `84': 35000,
  'Ford Escort Rally Car `98': 75000,
  'Ford FOCUS Rally Car `99': 85000,
  'BUICK GNX `87': 28000,
  'BUICK Special `62': 14000,

  // VW / other
  'Volkswagen Golf I GTI `76': 8500,
  'Volkswagen Karmann Ghia Coupe (Type-1) `68': 15000,

  // Alfa Romeo
  'Alfa Romeo 155 2.5 V6 TI `93': 55000,
  'Alfa Romeo 156 2.5 V6 24V `98': 28500,
  'Alfa Romeo 166 2.5 V6 24V Sportronic `98': 32500,
  'Alfa Romeo Giulia Sprint GTA 1600 `65': 85000,
  'Alfa Romeo Giulia Sprint Speciale `63': 75000,
  'Alfa Romeo Spider 1600 Duetto `66': 35000,

  // Lotus
  'Lotus Elise Sport 190 `98': 38000,

  // Custom / utility
  'Ambulance': 45000,
  'Tow Truck': 55000,
  'Police Cruiser': 28000,
  'Semi Truck': 95000,
  'Box Truck': 35000,

  // Daihatsu kei (JDM)
  'Daihatsu MIRA TR-XX Avanzato R `97': 9500,
  'Daihatsu MOVE CX `95': 8800,
  'Daihatsu MOVE SR-XX 2WD `97': 10000,
  'Daihatsu MOVE SR-XX 4WD `97': 10800,
  'Daihatsu Midget II D-type `98': 7500,
  'Daihatsu STORIA CX 2WD `98': 9200,
  'Daihatsu STORIA CX 4WD `98': 10200,

  // Suzuki kei (JDM)
  'Suzuki ALTO WORKS RS-Z `97': 10500,
  'Suzuki ALTO WORKS SUZUKI SPORT LIMITED `97': 11500,
  'Suzuki Cappuccino (EA11R) `91': 14000,
  'Suzuki Cappuccino (EA21R) `95': 14500,
  'Suzuki WAGON R RR `98': 11000,

  // DSM / Mitsubishi / Eagle
  'EAGLE Talon Esi `97': 19500,
  'Mitsubishi ECLIPSE GT `95': 21500,
  'Mitsubishi LEGNUM VR-4 Type V `98': 34000,
  'Mitsubishi MIRAGE CYBORG ZR `97': 17000,

  // Infiniti / Lexus
  'Infiniti G20 `90': 20500,
  'Lexus GS300 `91': 38000,
  'Lexus IS200 (J) `98': 30000,
  'Lexus IS200 `98': 30000,
  'Lexus SC300 `97': 44000,

  // Mercedes / European luxury
  'Mercedes-Benz 190 E 2.5 - 16 Evolution II `91': 55000,
  'Mercedes-Benz A 160 Avantgarde `98': 22000,
  'Mercedes-Benz SL 500 (R129) `98': 82000,
  'Mercedes-Benz SL 600 (R129) `98': 120000,
  'Mercedes-Benz SLK 230 Kompressor `98': 40000,

  // Jaguar
  'Jaguar XJ220 `92': 400000,
  'Jaguar XKR Coupe `99': 82000,

  // Lotus (more)
  'Lotus Carlton `90': 50000,
  'Lotus Esprit V8 GT `98': 85000,
  'Lotus Esprit V8 SE `98': 90000,
  'Lotus Motor Sport Elise `99': 50000,

  // TVR
  'TVR Cerbera Speed Six `97': 55000,
  'TVR Griffith 500 `94': 45000,
  'TVR V8S `91': 32000,

  // MG / Euro roadsters
  'MGF `97': 26000,

  // Opel / Peugeot / French hot hatches
  'Opel Tigra 1.6i `99': 17500,
  'Peugeot 206 S16 `99': 18000,
  'Peugeot 406 3.0 V6 Coupe `98': 35000,

  // Rally homologation
  'Lancia DELTA HF Integrale Evoluzione `91': 42000,

  // NISMO specials
  'NISMO 270R `94': 32000,
  'NISMO 400R `96': 125000,
  'NISMO GT-R LM Road Going Version `95': 450000,

  // Nissan (more)
  'Nissan CUBE X `98': 13000,
  'Nissan March G# `99': 12000,
  'Nissan R390 GT1 Road Car `98': 950000,
  'Nissan SKYLINE GTS-t Type M (R32) `91': 25000,
  'Nissan SKYLINE GTS25 Type S (R32) `91': 22000,
  'Nissan STAGEA 25t RS FOUR S `98': 32000,
  'Nissan STAGEA 260RS AutechVersion `98': 45000,

  // Fiat / other Euro
  'Fiat Panda Super i.e. `90': 8000,

  // Hommell / Cizeta
  'Hommell Berlinette R/S Coupe `99': 42000,
  'Cizeta V16T `94': 300000,

  // Toyota (more 90s)
  'Toyota CELICA GT-R (ST183, 4WS) `91': 17500,

  // Harley-Davidson (1990s)
  'Harley-Davidson Dyna Wide Glide `96': 16000,
  'Harley-Davidson Fat Boy `96': 17000,
  'Harley-Davidson Road Glide `98': 18500,
  'Harley-Davidson Road King `97': 16500,

  // Touring / JGTC race cars (never sold retail; 1999 collector values)
  'AMG Mercedes 190 E 2.5 - 16 Evolution II Touring Car `92': 185000,
  'Mitsubishi FTO Super Touring Car `97': 120000,
  'Opel Calibra Touring Car `94': 110000,
  'Nissan PENNZOIL Nismo GT-R (JGTC) `99': 250000,
  'Suzuki ESCUDO Dirt Trial Car `98': 180000,
};
