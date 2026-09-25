(* Механизм линии: двигатель прямого пуска, привод с ПЧ, заслонка с ПЧ или фотосепаратор.

   Режимы:
   - автомат (MODE_AUTO): работает по требованию маршрута. Пуск после задержки uTOn,
     когда все последующие механизмы уже работают (пуск от последнего к первому).
     Останов после задержки uTOff, когда нет требования и остановились все подающие
     механизмы (останов от первого к последнему);
   - ручной с панели (MODE_MAN): кнопки Пуск/Стоп, пуск разрешён только при работе
     последующих механизмов и неполных бункерах на выходе;
   - местный (MODE_LOCAL): ключ поста в "ручн.", кнопки поста;
   - наладка: ручной режим при GVL.xSetup - без блокировок и датчиков безопасности
     (кроме защит двигателя, аварийного стопа и аварии ПЧ).
   Переход между режимами безударный: команда работы сохраняется. *)
FUNCTION_BLOCK FB_Mech
VAR_INPUT
    stCfg       : ST_MechCfg;
    stIn        : ST_MechIn;
    xDemand     : BOOL;    (* требование активного маршрута *)
    xPredRun    : BOOL;    (* работает подающий механизм - удерживать в работе *)
    xSuccOkAuto : BOOL;    (* все последующие механизмы работают *)
    xSuccOkMan  : BOOL;    (* то же + бункеры на выходе не полны *)
    xPaused     : BOOL;    (* участок на паузе по ДВУ (для индикации) *)
END_VAR
VAR_IN_OUT
    stHmi : ST_MechHmi;
    stPar : ST_MechPar;
END_VAR
VAR_OUTPUT
    stOut     : ST_MechOut;
    xRun      : BOOL;      (* механизм в работе (для блокировок соседних) *)
    xCmd      : BOOL;      (* команда работы *)
    xReady    : BOOL;      (* готов к пуску в маршруте *)
    xAuto     : BOOL;
    xAlarm    : BOOL;
    xNewAlarm : BOOL;      (* появилась новая авария (один цикл) *)
END_VAR
VAR
    eMode      : INT;
    xManualReq : BOOL;
    xSetupNow  : BOOL;
    xStartReq  : BOOL;
    xStopReq   : BOOL;
    xMotorOn   : BOOL;     (* выход на двигатель был включен (предыдущий цикл) *)
    xSeqTrip   : BOOL;
    xSeqLatch  : BOOL;
    wAct       : WORD;
    wAlm       : WORD;
    xToDue     : BOOL;
    xOpened    : BOOL;
    xClosed    : BOOL;
    xGoOpen    : BOOL;
    xGoClose   : BOOL;
    xMoveBlock : BOOL;
    wSts       : WORD;
    uShTOn     : UINT;
    uShTOff    : UINT;
    uShTo      : UINT;
    wShByp     : WORD;
    tonStart   : TON;
    tonStop    : TON;
    tonDksRun  : TON;
    tonDksLost : TON;
    rtDks      : R_TRIG;
    tonDsl1    : TON;
    tonDsl2    : TON;
    tonDp      : TON;
    tonFb      : TON;
    tonMove    : TON;
    tpReset    : TP;
    rtCmd      : R_TRIG;
    ftCmd      : F_TRIG;
    tpOn       : TP;
    tpOff      : TP;
    rtLocStart : R_TRIG;
END_VAR

(* ---- уставки панель <-> RETAIN ---- *)
F_SyncUint(uMax := GVL_Const.T_MAX_S, uHmi := stHmi.uTOn, uPar := stPar.uTOn, uShadow := uShTOn);
F_SyncUint(uMax := GVL_Const.T_MAX_S, uHmi := stHmi.uTOff, uPar := stPar.uTOff, uShadow := uShTOff);
F_SyncUint(uMax := 60000, uHmi := stHmi.uToInterval, uPar := stPar.uToInterval, uShadow := uShTo);
F_SyncWord(wHmi := stHmi.wBypass, wPar := stPar.wBypass, wShadow := wShByp);

(* ---- команды панели ---- *)
xStartReq := (stHmi.wCmd AND GVL_Const.C_START) <> 0;
xStopReq := (stHmi.wCmd AND GVL_Const.C_STOP) <> 0;
IF (stHmi.wCmd AND GVL_Const.C_RESET_TO) <> 0 THEN
    stPar.udSecSinceTO := 0;
END_IF
stHmi.wCmd := stHmi.wCmd AND NOT (GVL_Const.C_START OR GVL_Const.C_STOP OR GVL_Const.C_RESET_TO);

(* механизм, занятый маршрутом, в ручной режим с панели не переводится *)
IF xDemand THEN
    stHmi.wCmd := stHmi.wCmd AND NOT GVL_Const.C_MANUAL;
END_IF
xManualReq := (stHmi.wCmd AND GVL_Const.C_MANUAL) <> 0;

IF stCfg.xHasLocal AND stIn.xLocal THEN
    eMode := GVL_Const.MODE_LOCAL;
ELSIF xManualReq THEN
    eMode := GVL_Const.MODE_MAN;
ELSE
    eMode := GVL_Const.MODE_AUTO;
END_IF
xSetupNow := GVL.xSetup AND eMode = GVL_Const.MODE_MAN;
xAuto := eMode = GVL_Const.MODE_AUTO;

(* ---- аварии ---- *)
wAct := 0;
IF stCfg.xHasQF AND NOT stIn.xQF THEN
    wAct := wAct OR GVL_Const.A_QF;
END_IF

tonDksRun(IN := xMotorOn AND stCfg.eDks <> GVL_Const.DKS_NONE, PT := F_Sec(GVL_Retain.stGlobPar.uTDksGrace));
rtDks(CLK := stIn.xDKS);
IF stCfg.eDks = GVL_Const.DKS_PULSE THEN
    (* таймер перезапускается каждым фронтом импульса *)
    tonDksLost(IN := tonDksRun.Q AND NOT rtDks.Q,
               PT := UDINT_TO_TIME(UINT_TO_UDINT(GVL_Retain.stGlobPar.uTDksPulse) * 100));
ELSE
    tonDksLost(IN := tonDksRun.Q AND NOT stIn.xDKS,
               PT := UDINT_TO_TIME(UINT_TO_UDINT(GVL_Retain.stGlobPar.uTDksPulse) * 100));
END_IF
IF tonDksLost.Q AND (stPar.wBypass AND GVL_Const.BY_DKS) = 0 THEN
    wAct := wAct OR GVL_Const.A_DKS;
END_IF

(* сбег ленты контролируется и на стоящей нории: пуск со сбежавшей лентой запрещён *)
tonDsl1(IN := stCfg.xHasDSL AND NOT stIn.xDSL1, PT := T#1S);
IF tonDsl1.Q AND (stPar.wBypass AND GVL_Const.BY_DSL1) = 0 THEN
    wAct := wAct OR GVL_Const.A_DSL1;
END_IF
tonDsl2(IN := stCfg.xHasDSL AND NOT stIn.xDSL2, PT := T#1S);
IF tonDsl2.Q AND (stPar.wBypass AND GVL_Const.BY_DSL2) = 0 THEN
    wAct := wAct OR GVL_Const.A_DSL2;
END_IF
tonDp(IN := stCfg.xHasDP AND NOT stIn.xDP, PT := T#2S);
IF tonDp.Q AND (stPar.wBypass AND GVL_Const.BY_DP) = 0 THEN
    wAct := wAct OR GVL_Const.A_DP;
END_IF

IF stCfg.xHasEStop AND NOT stIn.xEStop THEN
    wAct := wAct OR GVL_Const.A_ESTOP;
END_IF
(* местный "Стоп" при работе от панели/маршрута: механизм уже отключен аппаратно *)
IF stCfg.xHasLocal AND NOT stIn.xLocStop AND eMode <> GVL_Const.MODE_LOCAL AND (xCmd OR xDemand) THEN
    wAct := wAct OR GVL_Const.A_LOCSTOP;
END_IF

CASE stCfg.eKind OF
GVL_Const.K_FC:
    IF stIn.xFcFault THEN
        wAct := wAct OR GVL_Const.A_FC;
    END_IF
    tonFb(IN := xMotorOn AND NOT stIn.xFcReady, PT := F_Sec(GVL_Retain.stGlobPar.uTFcFb));
    IF tonFb.Q THEN
        wAct := wAct OR GVL_Const.A_FCFB;
    END_IF
GVL_Const.K_GATE:
    IF stIn.xFcFault THEN
        wAct := wAct OR GVL_Const.A_FC;
    END_IF
    tonMove(IN := stOut.qOpen OR stOut.qClose, PT := F_Sec(GVL_Retain.stGlobPar.uTGateMove));
    IF tonMove.Q THEN
        wAct := wAct OR GVL_Const.A_MOVE;
    END_IF
    IF stIn.xFb1 AND stIn.xFb2 THEN
        wAct := wAct OR GVL_Const.A_POS;
    END_IF
GVL_Const.K_FS:
    IF stIn.xErr THEN
        wAct := wAct OR GVL_Const.A_FSERR;
    END_IF
    tonFb(IN := xCmd AND NOT stIn.xFb1, PT := F_Sec(GVL_Retain.stGlobPar.uTFsStart));
    IF tonFb.Q THEN
        wAct := wAct OR GVL_Const.A_FSFB;
    END_IF
END_CASE

IF xSetupNow THEN
    wAct := wAct AND GVL_Const.A_HARD;
END_IF

(* фиксация аварий до сброса *)
xNewAlarm := (wAct AND NOT wAlm) <> 0;
IF GVL.xReset THEN
    wAlm := wAct;
    xSeqLatch := FALSE;
ELSE
    wAlm := wAlm OR wAct;
END_IF
xAlarm := wAlm <> 0;

(* ---- готовность к работе в маршруте ---- *)
xReady := NOT xAlarm AND xAuto AND GVL.xGlobalOk
    AND (NOT stCfg.xHasLocal OR stIn.xLocStop)
    AND (NOT stCfg.xHasEStop OR stIn.xEStop)
    AND (stCfg.eKind <> GVL_Const.K_FS
         OR (stIn.xFb2 AND (stIn.xAux OR (stPar.wBypass AND GVL_Const.BY_AUX) <> 0)));

(* ---- команда работы ---- *)
rtLocStart(CLK := stIn.xLocStart);
CASE eMode OF
GVL_Const.MODE_AUTO:
    tonStart(IN := xDemand AND xSuccOkAuto AND xReady AND NOT xCmd, PT := F_Sec(stPar.uTOn));
    IF tonStart.Q THEN
        xCmd := TRUE;
        xSeqLatch := FALSE;
    END_IF
    tonStop(IN := xCmd AND NOT xDemand AND NOT xPredRun, PT := F_Sec(stPar.uTOff));
    IF tonStop.Q THEN
        xCmd := FALSE;
    END_IF
    xSeqTrip := NOT xSuccOkAuto;

GVL_Const.MODE_MAN:
    tonStart(IN := FALSE);
    tonStop(IN := FALSE);
    IF xStartReq AND NOT xAlarm AND GVL.xGlobalOk AND (xSuccOkMan OR xSetupNow) THEN
        xCmd := TRUE;
        xSeqLatch := FALSE;
    END_IF
    IF xStopReq THEN
        xCmd := FALSE;
    END_IF
    xSeqTrip := NOT xSuccOkMan AND NOT xSetupNow;

GVL_Const.MODE_LOCAL:
    tonStart(IN := FALSE);
    tonStop(IN := FALSE);
    IF rtLocStart.Q AND NOT xAlarm AND stIn.xLocStop THEN
        xCmd := TRUE;
    END_IF
    IF NOT stIn.xLocStop THEN
        xCmd := FALSE;
    END_IF
    xSeqTrip := FALSE;
END_CASE

(* заслонка управляется в местном и ручном режимах кнопками открыть/закрыть, см. ниже *)
IF stCfg.eKind = GVL_Const.K_GATE AND eMode <> GVL_Const.MODE_AUTO THEN
    xCmd := FALSE;
    xSeqTrip := FALSE;
END_IF

IF xCmd AND xSeqTrip THEN
    xSeqLatch := TRUE;
END_IF
(* аварийный стоп, пожар, фазы, отключение цепи управления - останов сразу, без задержек *)
IF xAlarm OR NOT GVL.xGlobalOk OR xSeqTrip THEN
    xCmd := FALSE;
END_IF

(* ---- исполнительная часть ---- *)
stOut.qRun := FALSE;
stOut.qPower := FALSE;
stOut.qOpen := FALSE;
stOut.qClose := FALSE;
stOut.qEnable := FALSE;
tpReset(IN := GVL.xReset, PT := T#1S);
stOut.qReset := tpReset.Q;
rtCmd(CLK := xCmd);
ftCmd(CLK := xCmd);
tpOn(IN := rtCmd.Q AND stCfg.eKind = GVL_Const.K_FS, PT := T#1S);
tpOff(IN := ftCmd.Q AND stCfg.eKind = GVL_Const.K_FS, PT := T#1S);
stOut.qOn := tpOn.Q;
stOut.qOff := tpOff.Q;
xOpened := stIn.xFb1 AND NOT stIn.xFb2;
xClosed := stIn.xFb2 AND NOT stIn.xFb1;

CASE stCfg.eKind OF
GVL_Const.K_DOL:
    stOut.qRun := xCmd;
    xRun := xCmd;
    xMotorOn := xCmd;

GVL_Const.K_FC:
    stOut.qPower := GVL.xSysOn AND (NOT stCfg.xHasQF OR stIn.xQF);
    stOut.qRun := xCmd AND stOut.qPower;
    xRun := stOut.qRun;
    xMotorOn := stOut.qRun;

GVL_Const.K_GATE:
    stOut.qPower := GVL.xSysOn AND (NOT stCfg.xHasQF OR stIn.xQF);
    CASE eMode OF
    GVL_Const.MODE_AUTO:
        xGoOpen := xCmd;
        xGoClose := NOT xCmd;
    GVL_Const.MODE_MAN:
        xGoOpen := (stHmi.wCmd AND GVL_Const.C_OPEN) <> 0 AND (xSuccOkMan OR xSetupNow);
        xGoClose := (stHmi.wCmd AND GVL_Const.C_CLOSE) <> 0;
    ELSE
        xGoOpen := stIn.xLocOpen AND stIn.xLocStop;
        xGoClose := stIn.xLocClose AND stIn.xLocStop;
    END_CASE
    (* при общей аварии заслонка только закрывается - прекращение подачи продукта *)
    xGoOpen := xGoOpen AND GVL.xGlobalOk;
    (* ход прекращается при аварии привода или концевиков до сброса *)
    xMoveBlock := (wAlm AND (GVL_Const.A_QF OR GVL_Const.A_FC OR GVL_Const.A_MOVE OR GVL_Const.A_POS)) <> 0
        OR NOT stOut.qPower;
    stOut.qOpen := xGoOpen AND NOT xGoClose AND NOT xOpened AND NOT xMoveBlock;
    stOut.qClose := xGoClose AND NOT xGoOpen AND NOT xClosed AND NOT xMoveBlock;
    (* проём не закрыт - продукт может поступать на норию *)
    xRun := stOut.qOpen OR xOpened OR (NOT xClosed AND NOT xAlarm);
    xMotorOn := stOut.qOpen OR stOut.qClose;

GVL_Const.K_FS:
    stOut.qEnable := xCmd AND stIn.xFb1;
    xRun := xCmd AND stIn.xFb1;
    xMotorOn := xRun;
END_CASE

(* ---- моточасы ---- *)
IF xMotorOn AND GVL.xPulse1s THEN
    stPar.udSecTotal := stPar.udSecTotal + 1;
    stPar.udSecSinceTO := stPar.udSecSinceTO + 1;
END_IF
stHmi.uHoursTotal := UDINT_TO_UINT(MIN(stPar.udSecTotal / 3600, 65535));
stHmi.uMinutes := UDINT_TO_UINT((stPar.udSecTotal / 60) MOD 60);
stHmi.uHoursSinceTO := UDINT_TO_UINT(MIN(stPar.udSecSinceTO / 3600, 65535));
xToDue := stPar.uToInterval > 0 AND stPar.udSecSinceTO / 3600 >= UINT_TO_UDINT(stPar.uToInterval);

(* ---- состояние для панели ---- *)
wSts := 0;
IF xRun THEN wSts := wSts OR GVL_Const.S_RUN; END_IF
IF xCmd THEN wSts := wSts OR GVL_Const.S_CMD; END_IF
IF xReady THEN wSts := wSts OR GVL_Const.S_READY; END_IF
IF xAlarm THEN wSts := wSts OR GVL_Const.S_ALARM; END_IF
IF eMode = GVL_Const.MODE_LOCAL THEN wSts := wSts OR GVL_Const.S_LOCAL; END_IF
IF eMode = GVL_Const.MODE_MAN THEN wSts := wSts OR GVL_Const.S_MANUAL; END_IF
IF xSetupNow THEN wSts := wSts OR GVL_Const.S_SETUP; END_IF
IF tonStart.IN AND NOT xCmd THEN wSts := wSts OR GVL_Const.S_STARTING; END_IF
IF tonStop.IN THEN wSts := wSts OR GVL_Const.S_STOPPING; END_IF
IF xDemand THEN wSts := wSts OR GVL_Const.S_DEMAND; END_IF
IF xPaused THEN wSts := wSts OR GVL_Const.S_PAUSE; END_IF
IF xToDue THEN wSts := wSts OR GVL_Const.S_TO_DUE; END_IF
IF xOpened THEN wSts := wSts OR GVL_Const.S_OPENED; END_IF
IF xClosed THEN wSts := wSts OR GVL_Const.S_CLOSED; END_IF
IF xSeqLatch THEN wSts := wSts OR GVL_Const.S_SEQ_TRIP; END_IF
IF xSuccOkMan THEN wSts := wSts OR GVL_Const.S_SUCC_OK; END_IF
stHmi.wSts := wSts;
stHmi.wAlm := wAlm;

IF xAlarm THEN
    stHmi.iState := 4;
ELSIF eMode = GVL_Const.MODE_LOCAL THEN
    stHmi.iState := 5;
ELSIF tonStop.IN THEN
    stHmi.iState := 3;
ELSIF xRun THEN
    stHmi.iState := 2;
ELSIF tonStart.IN THEN
    stHmi.iState := 1;
ELSE
    stHmi.iState := 0;
END_IF
END_FUNCTION_BLOCK
