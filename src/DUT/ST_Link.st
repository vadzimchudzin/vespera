(* Связь "механизм подаёт на ..." для блокировок и последовательностей *)
TYPE ST_Link :
STRUCT
    iFrom    : INT;    (* индекс механизма-источника *)
    eTo      : INT;    (* GVL_Const.LT_MECH / LT_BUNKER / LT_INVALID *)
    iTo      : INT;    (* индекс механизма или бункера *)
    xProduct : BOOL;   (* TRUE - поток продукта (пауза по ДВУ распространяется назад),
                          FALSE - вспомогательная связь (аспирация, отходы) *)
END_STRUCT
END_TYPE
