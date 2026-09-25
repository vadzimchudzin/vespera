(* Рабочие переменные программы *)
VAR_GLOBAL
    (* ---- общие входы (заполняет PRG_Inputs) ---- *)
    xSysOnIn     : BOOL;                     (* 1K1: цепь управления включена *)
    aEStopIn     : ARRAY[1..10] OF BOOL;     (* 1 = аварийный стоп не нажат *)
    xFireOkIn    : BOOL;                     (* 1 = нет пожарной тревоги *)
    xPhaseOkIn   : BOOL;                     (* 1 = фазы в норме *)
    xFsAspPwrIn  : BOOL;
    xDryerOkIn   : BOOL;
    xComprOkIn   : BOOL;
    xCompr2OkIn  : BOOL;

    (* ---- общие флаги (PRG_System) ---- *)
    xSysOn     : BOOL;     (* цепь управления включена *)
    xGlobalOk  : BOOL;     (* цепь управления, аварийные стопы, пожар, фазы - в норме *)
    xReset     : BOOL;     (* импульс сброса аварий на один цикл *)
    xSetup     : BOOL;     (* режим наладки *)
    xStopAll   : BOOL;     (* импульс "остановить все маршруты" *)
    xPulse1s   : BOOL;     (* импульс раз в секунду на один цикл *)
    xBlink     : BOOL;     (* меандр 1 Гц *)
    xPreStart  : BOOL;     (* идёт предпусковой сигнал *)
    xAnyAlarm    : BOOL;
    xAnyNewAlarm : BOOL;
    qSiren     : BOOL;
    qLamp      : BOOL;

    (* ---- механизмы ---- *)
    aMechIn   : ARRAY[1..GVL_Const.N_MECH] OF ST_MechIn;
    aMechOut  : ARRAY[1..GVL_Const.N_MECH] OF ST_MechOut;
    aRun      : ARRAY[1..GVL_Const.N_MECH] OF BOOL;   (* механизм работает *)
    aReady    : ARRAY[1..GVL_Const.N_MECH] OF BOOL;   (* готов к работе в маршруте *)
    aAuto     : ARRAY[1..GVL_Const.N_MECH] OF BOOL;   (* в автоматическом режиме *)
    aAlarm    : ARRAY[1..GVL_Const.N_MECH] OF BOOL;
    aDemand   : ARRAY[1..GVL_Const.N_MECH] OF BOOL;   (* требуется активным маршрутом *)
    aPredRun  : ARRAY[1..GVL_Const.N_MECH] OF BOOL;   (* работает механизм, подающий на данный *)
    aSuccAuto : ARRAY[1..GVL_Const.N_MECH] OF BOOL;   (* все последующие механизмы работают *)
    aSuccMan  : ARRAY[1..GVL_Const.N_MECH] OF BOOL;   (* то же + бункеры на выходе не полны *)
    aBlocked  : ARRAY[1..GVL_Const.N_MECH] OF BOOL;   (* участок стоит на паузе по ДВУ *)

    (* ---- переключатели потока ---- *)
    aValveIn     : ARRAY[1..GVL_Const.N_VALVE] OF ST_ValveIn;
    aValveOut    : ARRAY[1..GVL_Const.N_VALVE] OF ST_ValveOut;
    aValvePos    : ARRAY[1..GVL_Const.N_VALVE] OF INT;   (* 0 - не определено, 1, 2 *)
    aValveTarget : ARRAY[1..GVL_Const.N_VALVE] OF INT;   (* задание от маршрутов *)
    aValveReady  : ARRAY[1..GVL_Const.N_VALVE] OF BOOL;
    aValveAlarm  : ARRAY[1..GVL_Const.N_VALVE] OF BOOL;

    (* ---- бункеры ---- *)
    aBunkerIn    : ARRAY[1..GVL_Const.N_BUNKER] OF ST_BunkerIn;
    aBunkerFull  : ARRAY[1..GVL_Const.N_BUNKER] OF BOOL;
    aBunkerAlarm : ARRAY[1..GVL_Const.N_BUNKER] OF BOOL;

    (* ---- связи и маршруты ---- *)
    aLinks       : ARRAY[1..GVL_Const.N_LINK] OF ST_Link;
    nLinks       : INT;
    aMember      : ARRAY[1..GVL_Const.N_ROUTE, 1..GVL_Const.N_MECH] OF BOOL;    (* состав маршрута *)
    aMemberB     : ARRAY[1..GVL_Const.N_ROUTE, 1..GVL_Const.N_BUNKER] OF BOOL;  (* бункеры маршрута *)
    aRouteCfgErr : ARRAY[1..GVL_Const.N_ROUTE] OF BOOL;
    aRouteState  : ARRAY[1..GVL_Const.N_ROUTE] OF INT;
    aRouteFault  : ARRAY[1..GVL_Const.N_ROUTE] OF BOOL;
END_VAR
