(* Уставки и счётчики механизма, хранятся в RETAIN *)
TYPE ST_MechPar :
STRUCT
    uTOn         : UINT;     (* задержка пуска, с *)
    uTOff        : UINT;     (* задержка останова, с *)
    uToInterval  : UINT;     (* интервал ТО, ч; 0 = не контролировать *)
    wBypass      : WORD;     (* отключенные датчики, маски GVL_Const.BY_* *)
    udSecTotal   : UDINT;    (* наработка всего, с *)
    udSecSinceTO : UDINT;    (* наработка после ТО, с *)
END_STRUCT
END_TYPE
