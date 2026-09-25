(* Переключатель потока ППМ-2 с электроприводом (поз.12(1)..12(4)) и
   механизм промежуточной выгрузки Z-нории поз.26 (пневмораспределитель 49YA1/49YA2).
   Выход держится до срабатывания датчика положения. Положение задаёт маршрут;
   в ручном режиме - кнопки панели, если подающий механизм стоит. *)
FUNCTION_BLOCK FB_Valve
VAR_INPUT
    xHasSF  : BOOL;
    stIn    : ST_ValveIn;
    iTarget : INT;      (* 0 - нет задания маршрута, 1/2 - положение *)
    xFlow   : BOOL;     (* подающий механизм работает *)
END_VAR
VAR_IN_OUT
    stHmi : ST_ValveHmi;
    stPar : ST_ValvePar;
END_VAR
VAR_OUTPUT
    stOut     : ST_ValveOut;
    iPos      : INT;    (* 0 - не определено, 1, 2 *)
    xReady    : BOOL;
    xAlarm    : BOOL;
    xNewAlarm : BOOL;
END_VAR
VAR
    iGoal    : INT;
    xManual  : BOOL;
    xReq1    : BOOL;
    xReq2    : BOOL;
    xMove1   : BOOL;
    xMove2   : BOOL;
    wAct     : WORD;
    wAlm     : WORD;
    wSts     : WORD;
    uShMove  : UINT;
    tonMove  : TON;
    tofQ1    : TOF;
    tofQ2    : TOF;
END_VAR

F_SyncUint(uMax := 600, uHmi := stHmi.uTMove, uPar := stPar.uTMove, uShadow := uShMove);

IF stIn.xS1 AND NOT stIn.xS2 THEN
    iPos := 1;
ELSIF stIn.xS2 AND NOT stIn.xS1 THEN
    iPos := 2;
ELSE
    iPos := 0;
END_IF

(* ---- аварии ---- *)
wAct := 0;
IF xHasSF AND NOT stIn.xSF THEN
    wAct := wAct OR GVL_Const.VA_SF;
END_IF
tonMove(IN := stOut.q1 OR stOut.q2, PT := F_Sec(stPar.uTMove));
IF tonMove.Q THEN
    wAct := wAct OR GVL_Const.VA_TIMEOUT;
END_IF
IF stIn.xS1 AND stIn.xS2 THEN
    wAct := wAct OR GVL_Const.VA_BOTH;
END_IF
xNewAlarm := (wAct AND NOT wAlm) <> 0;
IF GVL.xReset THEN
    wAlm := wAct;
ELSE
    wAlm := wAlm OR wAct;
END_IF
xAlarm := wAlm <> 0;

(* ---- задание положения ---- *)
IF iTarget <> 0 THEN
    stHmi.wCmd := stHmi.wCmd AND NOT GVL_Const.VC_MANUAL;
END_IF
xManual := (stHmi.wCmd AND GVL_Const.VC_MANUAL) <> 0;
xReq1 := (stHmi.wCmd AND GVL_Const.VC_POS1) <> 0;
xReq2 := (stHmi.wCmd AND GVL_Const.VC_POS2) <> 0;
stHmi.wCmd := stHmi.wCmd AND NOT (GVL_Const.VC_POS1 OR GVL_Const.VC_POS2);

IF iTarget <> 0 THEN
    iGoal := iTarget;
ELSIF xManual THEN
    IF NOT xFlow OR GVL.xSetup THEN
        IF xReq1 THEN
            iGoal := 1;
        ELSIF xReq2 THEN
            iGoal := 2;
        END_IF
    END_IF
ELSE
    iGoal := 0;
END_IF

xMove1 := iGoal = 1 AND iPos <> 1 AND NOT xAlarm AND GVL.xGlobalOk;
xMove2 := iGoal = 2 AND iPos <> 2 AND NOT xAlarm AND GVL.xGlobalOk;
(* пауза 0,5 с при реверсе привода *)
stOut.q1 := xMove1 AND NOT tofQ2.Q;
stOut.q2 := xMove2 AND NOT tofQ1.Q AND NOT stOut.q1;
tofQ1(IN := stOut.q1, PT := T#500MS);
tofQ2(IN := stOut.q2, PT := T#500MS);

xReady := NOT xAlarm AND NOT xManual;

wSts := 0;
IF iPos = 1 THEN wSts := wSts OR GVL_Const.VS_POS1; END_IF
IF iPos = 2 THEN wSts := wSts OR GVL_Const.VS_POS2; END_IF
IF stOut.q1 OR stOut.q2 THEN wSts := wSts OR GVL_Const.VS_MOVING; END_IF
IF xAlarm THEN wSts := wSts OR GVL_Const.VS_ALARM; END_IF
IF xManual THEN wSts := wSts OR GVL_Const.VS_MANUAL; END_IF
IF iTarget <> 0 THEN wSts := wSts OR GVL_Const.VS_ROUTE; END_IF
IF xFlow THEN wSts := wSts OR GVL_Const.VS_FLOW; END_IF
stHmi.wSts := wSts;
stHmi.wAlm := wAlm;
END_FUNCTION_BLOCK
