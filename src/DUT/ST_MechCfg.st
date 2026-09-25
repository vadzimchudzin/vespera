(* Постоянная конфигурация механизма *)
TYPE ST_MechCfg :
STRUCT
    eKind     : INT;     (* GVL_Const.K_DOL / K_FC / K_GATE / K_FS *)
    xHasQF    : BOOL;    (* контроль автомата защиты (QF/SF) *)
    eDks      : INT;     (* GVL_Const.DKS_NONE / DKS_PULSE / DKS_LEVEL *)
    xHasDSL   : BOOL;    (* датчики сбегания ленты 1 и 2 *)
    xHasDP    : BOOL;    (* датчик подпора *)
    xHasLocal : BOOL;    (* пост местного управления: ключ Авт/Ручн, Пуск, Стоп *)
    xHasEStop : BOOL;    (* аварийный/концевой стоп у механизма *)
    uDefTOn   : UINT;    (* задержка пуска по умолчанию, с *)
    uDefTOff  : UINT;    (* задержка останова по умолчанию, с *)
END_STRUCT
END_TYPE
