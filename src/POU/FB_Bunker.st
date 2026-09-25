(* Бункер с датчиком верхнего уровня. Полный бункер ставит на паузу подающий участок
   маршрута; после освобождения и задержки uTRestart участок запускается снова. *)
FUNCTION_BLOCK FB_Bunker
VAR_INPUT
    xHasSF : BOOL;
    stIn   : ST_BunkerIn;
END_VAR
VAR_IN_OUT
    stHmi : ST_BunkerHmi;
    stPar : ST_BunkerPar;
END_VAR
VAR_OUTPUT
    xFull     : BOOL;
    xAlarm    : BOOL;
    xNewAlarm : BOOL;
END_VAR
VAR
    xDvu      : BOOL;
    wAct      : WORD;
    wAlm      : WORD;
    wSts      : WORD;
    uShDvu    : UINT;
    uShRst    : UINT;
    wShByp    : WORD;
    tonFull   : TON;
    tonClear  : TON;
END_VAR

F_SyncUint(uMax := 600, uHmi := stHmi.uTDvu, uPar := stPar.uTDvu, uShadow := uShDvu);
F_SyncUint(uMax := GVL_Const.T_MAX_S, uHmi := stHmi.uTRestart, uPar := stPar.uTRestart, uShadow := uShRst);
F_SyncWord(wHmi := stHmi.wBypass, wPar := stPar.wBypass, wShadow := wShByp);

xDvu := stIn.xDVU AND (stPar.wBypass AND GVL_Const.BY_DVU) = 0;
tonFull(IN := xDvu, PT := F_Sec(stPar.uTDvu));
tonClear(IN := NOT xDvu, PT := F_Sec(stPar.uTRestart));
IF tonFull.Q THEN
    xFull := TRUE;
ELSIF tonClear.Q THEN
    xFull := FALSE;
END_IF

wAct := 0;
IF xHasSF AND NOT stIn.xSF THEN
    wAct := wAct OR GVL_Const.BA_SF;
END_IF
xNewAlarm := (wAct AND NOT wAlm) <> 0;
IF GVL.xReset THEN
    wAlm := wAct;
ELSE
    wAlm := wAlm OR wAct;
END_IF
xAlarm := wAlm <> 0;

wSts := 0;
IF stIn.xDVU THEN wSts := wSts OR GVL_Const.BS_DVU; END_IF
IF xFull THEN wSts := wSts OR GVL_Const.BS_FULL; END_IF
IF stIn.xDNU THEN wSts := wSts OR GVL_Const.BS_DNU; END_IF
IF (stPar.wBypass AND GVL_Const.BY_DVU) <> 0 THEN wSts := wSts OR GVL_Const.BS_BYPASS; END_IF
IF xAlarm THEN wSts := wSts OR GVL_Const.BS_ALARM; END_IF
stHmi.wSts := wSts;
stHmi.wAlm := wAlm;
END_FUNCTION_BLOCK
