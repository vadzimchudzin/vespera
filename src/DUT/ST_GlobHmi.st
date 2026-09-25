(* Общий блок, %MW0..%MW31 *)
TYPE ST_GlobHmi :
STRUCT
    wCmd        : WORD;  (* +0  маски GVL_Const.G_* *)
    wSts        : WORD;  (* +1  маски GVL_Const.GS_* *)
    wAlm        : WORD;  (* +2  аварийные стопы 1..10 (биты 0..9), 10 пожар, 11 фазы *)
    wWarn       : WORD;  (* +3  маски GVL_Const.GW_* *)
    uHeartbeat  : UINT;  (* +4  счётчик секунд, контроль связи *)
    uTPreStart  : UINT;  (* +5  предпусковой сигнал, с *)
    uTDksGrace  : UINT;  (* +6  разгон до контроля ДКС, с *)
    uTDksPulse  : UINT;  (* +7  нет импульсов ДКС, 0.1 с *)
    uTFcFb      : UINT;  (* +8  нет сигнала работы ПЧ, с *)
    uTFsStart   : UINT;  (* +9  нет статуса фотосепаратора после пуска, с *)
    uTGateMove  : UINT;  (* +10 контроль хода заслонки поз.1, с *)
    uSirenOn    : UINT;  (* +11 1 = аварийная сирена разрешена *)
    uRes        : ARRAY[12..31] OF UINT;
END_STRUCT
END_TYPE
