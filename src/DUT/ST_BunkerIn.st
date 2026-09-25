TYPE ST_BunkerIn :
STRUCT
    xDVU : BOOL;   (* 1 = верхний уровень *)
    xDNU : BOOL;   (* 1 = продукт на нижнем уровне (для бункера поз.27 - второй датчик) *)
    xSF  : BOOL;   (* станции TORBA: 1 = автомат пульта управления включен *)
END_STRUCT
END_TYPE
