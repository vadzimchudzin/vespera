(* Общие сигналы: цепь управления, аварийные стопы, пожар, контроль фаз, сброс, наладка,
   сирена и лампа "Авария", секундный импульс, уставки по умолчанию. *)
PROGRAM PRG_System
VAR
    i         : INT;
    wAct      : WORD;
    wAlm      : WORD;
    wWarn     : WORD;
    wSts      : WORD;
    xNewG     : BOOL;
    xSirenLatch : BOOL;
    tonSec    : TON;
    tonBlink  : TON;
    xBlinkReq : BOOL;
    uSh       : ARRAY[1..7] OF UINT;
END_VAR

(* ---- уставки по умолчанию при первом запуске / потере RETAIN ---- *)
IF GVL_Retain.uInitMagic <> GVL_Const.RETAIN_MAGIC THEN
    GVL_Retain.stGlobPar.uTPreStart := 10;
    GVL_Retain.stGlobPar.uTDksGrace := 5;
    GVL_Retain.stGlobPar.uTDksPulse := 30;
    GVL_Retain.stGlobPar.uTFcFb := 5;
    GVL_Retain.stGlobPar.uTFsStart := 60;
    GVL_Retain.stGlobPar.uTGateMove := 90;
    GVL_Retain.stGlobPar.uSirenOn := 1;
    FOR i := 1 TO GVL_Const.N_MECH DO
        GVL_Retain.aMechPar[i].uTOn := GVL_Const.MECH_CFG[i].uDefTOn;
        GVL_Retain.aMechPar[i].uTOff := GVL_Const.MECH_CFG[i].uDefTOff;
        GVL_Retain.aMechPar[i].uToInterval := 0;
        GVL_Retain.aMechPar[i].wBypass := 0;
    END_FOR
    FOR i := 1 TO GVL_Const.N_VALVE DO
        GVL_Retain.aValvePar[i].uTMove := 30;
    END_FOR
    FOR i := 1 TO GVL_Const.N_BUNKER DO
        GVL_Retain.aBunkerPar[i].wBypass := 0;
        GVL_Retain.aBunkerPar[i].uTDvu := 3;
        GVL_Retain.aBunkerPar[i].uTRestart := 30;
    END_FOR
    GVL_Retain.uInitMagic := GVL_Const.RETAIN_MAGIC;
END_IF

F_SyncUint(uMax := 600, uHmi := GVL_HMI.stHmiG.uTPreStart, uPar := GVL_Retain.stGlobPar.uTPreStart, uShadow := uSh[1]);
F_SyncUint(uMax := 600, uHmi := GVL_HMI.stHmiG.uTDksGrace, uPar := GVL_Retain.stGlobPar.uTDksGrace, uShadow := uSh[2]);
F_SyncUint(uMax := 600, uHmi := GVL_HMI.stHmiG.uTDksPulse, uPar := GVL_Retain.stGlobPar.uTDksPulse, uShadow := uSh[3]);
F_SyncUint(uMax := 600, uHmi := GVL_HMI.stHmiG.uTFcFb, uPar := GVL_Retain.stGlobPar.uTFcFb, uShadow := uSh[4]);
F_SyncUint(uMax := 600, uHmi := GVL_HMI.stHmiG.uTFsStart, uPar := GVL_Retain.stGlobPar.uTFsStart, uShadow := uSh[5]);
F_SyncUint(uMax := 600, uHmi := GVL_HMI.stHmiG.uTGateMove, uPar := GVL_Retain.stGlobPar.uTGateMove, uShadow := uSh[6]);
F_SyncUint(uMax := 1, uHmi := GVL_HMI.stHmiG.uSirenOn, uPar := GVL_Retain.stGlobPar.uSirenOn, uShadow := uSh[7]);

(* ---- такты ---- *)
tonSec(IN := NOT tonSec.Q, PT := T#1S);
GVL.xPulse1s := tonSec.Q;
tonBlink(IN := NOT tonBlink.Q, PT := T#500MS);
IF tonBlink.Q THEN
    xBlinkReq := NOT xBlinkReq;
END_IF
GVL.xBlink := xBlinkReq;
IF GVL.xPulse1s THEN
    GVL_HMI.stHmiG.uHeartbeat := GVL_HMI.stHmiG.uHeartbeat + 1;
END_IF

(* ---- команды панели ---- *)
GVL.xReset := (GVL_HMI.stHmiG.wCmd AND GVL_Const.G_RESET) <> 0;
GVL.xStopAll := (GVL_HMI.stHmiG.wCmd AND GVL_Const.G_STOPALL) <> 0;
IF (GVL_HMI.stHmiG.wCmd AND GVL_Const.G_MUTE) <> 0 OR GVL.xReset THEN
    xSirenLatch := FALSE;
END_IF
GVL.xSetup := (GVL_HMI.stHmiG.wCmd AND GVL_Const.G_SETUP) <> 0;
GVL_HMI.stHmiG.wCmd := GVL_HMI.stHmiG.wCmd AND NOT (GVL_Const.G_RESET OR GVL_Const.G_MUTE OR GVL_Const.G_STOPALL);

(* ---- общие аварии ---- *)
GVL.xSysOn := GVL.xSysOnIn;
wAct := 0;
FOR i := 1 TO 10 DO
    IF NOT GVL.aEStopIn[i] THEN
        wAct := wAct OR SHL(WORD#1, i - 1);
    END_IF
END_FOR
IF NOT GVL.xFireOkIn THEN
    wAct := wAct OR GVL_Const.GA_FIRE;
END_IF
IF NOT GVL.xPhaseOkIn THEN
    wAct := wAct OR GVL_Const.GA_PHASE;
END_IF
xNewG := (wAct AND NOT wAlm) <> 0;
IF GVL.xReset THEN
    wAlm := wAct;
ELSE
    wAlm := wAlm OR wAct;
END_IF
GVL.xGlobalOk := GVL.xSysOn AND wAlm = 0;

wWarn := 0;
IF NOT GVL.xComprOkIn THEN wWarn := wWarn OR GVL_Const.GW_COMPR; END_IF
IF NOT GVL.xCompr2OkIn THEN wWarn := wWarn OR GVL_Const.GW_COMPR2; END_IF
IF NOT GVL.xDryerOkIn THEN wWarn := wWarn OR GVL_Const.GW_DRYER; END_IF
IF NOT GVL.xFsAspPwrIn THEN wWarn := wWarn OR GVL_Const.GW_FSASP; END_IF
IF NOT GVL.xSysOn THEN wWarn := wWarn OR GVL_Const.GW_SYSOFF; END_IF
(* сжатый воздух нужен фотосепаратору *)
GVL.aMechIn[GVL_Const.M_FS27].xAux := GVL.xComprOkIn;

(* ---- сирена и лампа (GVL.xAnyAlarm / xAnyNewAlarm - от механизмов, предыдущий цикл) ---- *)
IF (xNewG OR GVL.xAnyNewAlarm) AND GVL_Retain.stGlobPar.uSirenOn <> 0 THEN
    xSirenLatch := TRUE;
END_IF
(* предпусковой сигнал - прерывистый, звучит всегда *)
GVL.qSiren := xSirenLatch OR (GVL.xPreStart AND GVL.xBlink);
GVL.qLamp := (GVL.xAnyAlarm OR wAlm <> 0) AND (GVL.xBlink OR NOT xSirenLatch);

wSts := 0;
IF GVL.xSysOn THEN wSts := wSts OR GVL_Const.GS_SYSON; END_IF
IF GVL.xGlobalOk THEN wSts := wSts OR GVL_Const.GS_OK; END_IF
IF GVL.xAnyAlarm OR wAlm <> 0 THEN wSts := wSts OR GVL_Const.GS_ALARM; END_IF
IF GVL.qSiren THEN wSts := wSts OR GVL_Const.GS_SIREN; END_IF
IF GVL.xSetup THEN wSts := wSts OR GVL_Const.GS_SETUP; END_IF
IF GVL.xPreStart THEN wSts := wSts OR GVL_Const.GS_PRESTART; END_IF
GVL_HMI.stHmiG.wSts := wSts;
GVL_HMI.stHmiG.wAlm := wAlm;
GVL_HMI.stHmiG.wWarn := wWarn;
END_PROGRAM
