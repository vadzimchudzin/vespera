(* Маршруты (Приложение 5). Пуск: проверка готовности -> предпусковой сигнал ->
   перевод клапанов -> работа (механизмы запускаются от последнего к первому).
   Стоп: снятие требования (останов от первого к последнему с задержками).
   Авария механизма/клапана/бункера маршрута или общая авария - останов маршрута. *)
PROGRAM PRG_Routes
VAR
    xInit     : BOOL;
    r         : INT;
    p         : INT;
    i         : INT;
    v         : INT;
    b         : INT;
    h         : INT;
    k         : INT;
    nL        : INT;
    aPosT     : ARRAY[1..GVL_Const.N_VALVE] OF INT;
    aL        : ARRAY[1..GVL_Const.N_LINK] OF ST_Link;
    aTonPre   : ARRAY[1..GVL_Const.N_ROUTE] OF TON;
    xToggle   : BOOL;
    xStop     : BOOL;
    xConflict : BOOL;
    xFault    : BOOL;
    xBusy     : BOOL;
    xShared   : BOOL;
    xPaused   : BOOL;
    xAllRun   : BOOL;
    xValvesOk : BOOL;
    iBad      : INT;
    wSts      : WORD;
    aNotReady : ARRAY[1..GVL_Const.N_ROUTE] OF BOOL;
END_VAR

(* ---- состав маршрутов: обход связей от головных механизмов при положениях клапанов маршрута ---- *)
IF NOT xInit THEN
    FOR r := 1 TO GVL_Const.N_ROUTE DO
        FOR v := 1 TO GVL_Const.N_VALVE DO
            aPosT[v] := GVL_Const.ROUTE_VALVE[r, v];
        END_FOR
        nL := F_BuildLinks(aPos := aPosT, aLinks := aL);
        FOR i := 1 TO GVL_Const.N_MECH DO
            GVL.aMember[r, i] := FALSE;
        END_FOR
        FOR b := 1 TO GVL_Const.N_BUNKER DO
            GVL.aMemberB[r, b] := FALSE;
        END_FOR
        GVL.aRouteCfgErr[r] := FALSE;
        FOR h := 1 TO GVL_Const.N_HEAD DO
            IF GVL_Const.ROUTE_HEAD[r, h] > 0 THEN
                GVL.aMember[r, GVL_Const.ROUTE_HEAD[r, h]] := TRUE;
            END_IF
        END_FOR
        FOR p := 1 TO GVL_Const.N_MECH DO
            FOR k := 1 TO nL DO
                IF GVL.aMember[r, aL[k].iFrom] THEN
                    CASE aL[k].eTo OF
                    GVL_Const.LT_MECH:
                        GVL.aMember[r, aL[k].iTo] := TRUE;
                    GVL_Const.LT_BUNKER:
                        GVL.aMemberB[r, aL[k].iTo] := TRUE;
                    ELSE
                        GVL.aRouteCfgErr[r] := TRUE;
                    END_CASE
                END_IF
            END_FOR
        END_FOR
    END_FOR
    xInit := TRUE;
END_IF

FOR r := 1 TO GVL_Const.N_ROUTE DO
    xToggle := (GVL_HMI.aHmiRoute[r].wCmd AND GVL_Const.RC_TOGGLE) <> 0;
    xStop := (GVL_HMI.aHmiRoute[r].wCmd AND GVL_Const.RC_STOP) <> 0 OR GVL.xStopAll;
    GVL_HMI.aHmiRoute[r].wCmd := 0;

    xConflict := FALSE;
    FOR p := 1 TO GVL_Const.N_ROUTE DO
        IF p <> r AND GVL_Const.ROUTE_CONFLICT[r, p] AND GVL.aRouteState[p] <> GVL_Const.RST_IDLE THEN
            xConflict := TRUE;
        END_IF
    END_FOR

    xValvesOk := TRUE;
    FOR v := 1 TO GVL_Const.N_VALVE DO
        IF GVL_Const.ROUTE_VALVE[r, v] <> 0 AND GVL.aValvePos[v] <> GVL_Const.ROUTE_VALVE[r, v] THEN
            xValvesOk := FALSE;
        END_IF
    END_FOR

    (* ---- контроль аварий активного маршрута ---- *)
    IF GVL.aRouteState[r] <> GVL_Const.RST_IDLE AND GVL.aRouteState[r] <> GVL_Const.RST_STOPPING THEN
        xFault := NOT GVL.xGlobalOk;
        FOR i := 1 TO GVL_Const.N_MECH DO
            IF GVL.aMember[r, i] AND (GVL.aAlarm[i] OR NOT GVL.aAuto[i]) THEN
                xFault := TRUE;
            END_IF
        END_FOR
        FOR v := 1 TO GVL_Const.N_VALVE DO
            IF GVL_Const.ROUTE_VALVE[r, v] <> 0 AND GVL.aValveAlarm[v] THEN
                xFault := TRUE;
            END_IF
        END_FOR
        FOR b := 1 TO GVL_Const.N_BUNKER DO
            IF GVL.aMemberB[r, b] AND GVL.aBunkerAlarm[b] THEN
                xFault := TRUE;
            END_IF
        END_FOR
        IF GVL.aRouteState[r] = GVL_Const.RST_RUN AND NOT xValvesOk THEN
            xFault := TRUE;
        END_IF
        IF xFault THEN
            GVL.aRouteFault[r] := TRUE;
            GVL.aRouteState[r] := GVL_Const.RST_STOPPING;
        END_IF
    END_IF

    CASE GVL.aRouteState[r] OF
    GVL_Const.RST_IDLE:
        IF GVL.xReset THEN
            GVL.aRouteFault[r] := FALSE;
            aNotReady[r] := FALSE;
        END_IF
        IF xToggle THEN
            iBad := 0;
            IF NOT GVL.xGlobalOk THEN
                iBad := -1;
            ELSIF xConflict THEN
                iBad := -2;
            ELSIF GVL.aRouteCfgErr[r] THEN
                iBad := -3;
            ELSE
                FOR i := GVL_Const.N_MECH TO 1 BY -1 DO
                    IF GVL.aMember[r, i] AND NOT GVL.aReady[i] THEN
                        iBad := i;
                    END_IF
                END_FOR
                IF iBad = 0 THEN
                    FOR v := GVL_Const.N_VALVE TO 1 BY -1 DO
                        IF GVL_Const.ROUTE_VALVE[r, v] <> 0 AND NOT GVL.aValveReady[v] THEN
                            iBad := 100 + v;
                        END_IF
                    END_FOR
                END_IF
                IF iBad = 0 THEN
                    FOR b := GVL_Const.N_BUNKER TO 1 BY -1 DO
                        IF GVL.aMemberB[r, b] AND GVL.aBunkerAlarm[b] THEN
                            iBad := 200 + b;
                        END_IF
                    END_FOR
                END_IF
            END_IF
            GVL_HMI.aHmiRoute[r].iNotReady := iBad;
            aNotReady[r] := iBad <> 0;
            IF iBad = 0 THEN
                GVL.aRouteFault[r] := FALSE;
                GVL.aRouteState[r] := GVL_Const.RST_PRESTART;
            END_IF
        END_IF

    GVL_Const.RST_PRESTART:
        IF xStop OR xToggle THEN
            GVL.aRouteState[r] := GVL_Const.RST_IDLE;
        ELSIF aTonPre[r].Q THEN
            GVL.aRouteState[r] := GVL_Const.RST_VALVES;
        END_IF

    GVL_Const.RST_VALVES:
        IF xStop OR xToggle THEN
            GVL.aRouteState[r] := GVL_Const.RST_STOPPING;
        ELSIF xValvesOk THEN
            GVL.aRouteState[r] := GVL_Const.RST_RUN;
        END_IF

    GVL_Const.RST_RUN:
        IF xStop OR xToggle THEN
            GVL.aRouteState[r] := GVL_Const.RST_STOPPING;
        END_IF

    GVL_Const.RST_STOPPING:
        (* ждать останова всех механизмов маршрута, кроме занятых другим работающим маршрутом *)
        xBusy := FALSE;
        FOR i := 1 TO GVL_Const.N_MECH DO
            IF GVL.aMember[r, i] AND GVL.aRun[i] THEN
                xShared := FALSE;
                FOR p := 1 TO GVL_Const.N_ROUTE DO
                    IF p <> r AND GVL.aRouteState[p] = GVL_Const.RST_RUN AND GVL.aMember[p, i] THEN
                        xShared := TRUE;
                    END_IF
                END_FOR
                IF NOT xShared THEN
                    xBusy := TRUE;
                END_IF
            END_IF
        END_FOR
        IF NOT xBusy THEN
            GVL.aRouteState[r] := GVL_Const.RST_IDLE;
        END_IF
    END_CASE

    aTonPre[r](IN := GVL.aRouteState[r] = GVL_Const.RST_PRESTART,
               PT := F_Sec(GVL_Retain.stGlobPar.uTPreStart));
END_FOR

(* ---- требования к механизмам и клапанам ---- *)
FOR i := 1 TO GVL_Const.N_MECH DO
    GVL.aDemand[i] := FALSE;
    FOR r := 1 TO GVL_Const.N_ROUTE DO
        IF GVL.aRouteState[r] = GVL_Const.RST_RUN AND GVL.aMember[r, i] THEN
            GVL.aDemand[i] := TRUE;
        END_IF
    END_FOR
    GVL.aDemand[i] := GVL.aDemand[i] AND NOT GVL.aBlocked[i];
END_FOR

GVL.xPreStart := FALSE;
FOR v := 1 TO GVL_Const.N_VALVE DO
    GVL.aValveTarget[v] := 0;
END_FOR
FOR r := 1 TO GVL_Const.N_ROUTE DO
    IF GVL.aRouteState[r] = GVL_Const.RST_PRESTART THEN
        GVL.xPreStart := TRUE;
    END_IF
    IF GVL.aRouteState[r] <> GVL_Const.RST_IDLE THEN
        FOR v := 1 TO GVL_Const.N_VALVE DO
            IF GVL_Const.ROUTE_VALVE[r, v] <> 0 THEN
                GVL.aValveTarget[v] := GVL_Const.ROUTE_VALVE[r, v];
            END_IF
        END_FOR
    END_IF
END_FOR

(* ---- состояние для панели ---- *)
FOR r := 1 TO GVL_Const.N_ROUTE DO
    xConflict := FALSE;
    FOR p := 1 TO GVL_Const.N_ROUTE DO
        IF p <> r AND GVL_Const.ROUTE_CONFLICT[r, p] AND GVL.aRouteState[p] <> GVL_Const.RST_IDLE THEN
            xConflict := TRUE;
        END_IF
    END_FOR
    xPaused := FALSE;
    xAllRun := GVL.aRouteState[r] = GVL_Const.RST_RUN;
    FOR i := 1 TO GVL_Const.N_MECH DO
        IF GVL.aMember[r, i] THEN
            IF GVL.aBlocked[i] THEN
                xPaused := TRUE;
            ELSIF NOT GVL.aRun[i] THEN
                xAllRun := FALSE;
            END_IF
        END_IF
    END_FOR
    wSts := 0;
    IF GVL.aRouteState[r] <> GVL_Const.RST_IDLE THEN wSts := wSts OR GVL_Const.RS_ACTIVE; END_IF
    IF GVL.aRouteState[r] = GVL_Const.RST_PRESTART THEN wSts := wSts OR GVL_Const.RS_PRESTART; END_IF
    IF GVL.aRouteState[r] = GVL_Const.RST_VALVES THEN wSts := wSts OR GVL_Const.RS_VALVES; END_IF
    IF GVL.aRouteState[r] = GVL_Const.RST_RUN THEN wSts := wSts OR GVL_Const.RS_RUN; END_IF
    IF GVL.aRouteState[r] = GVL_Const.RST_STOPPING THEN wSts := wSts OR GVL_Const.RS_STOPPING; END_IF
    IF xPaused AND GVL.aRouteState[r] = GVL_Const.RST_RUN THEN wSts := wSts OR GVL_Const.RS_PAUSED; END_IF
    IF GVL.aRouteFault[r] THEN wSts := wSts OR GVL_Const.RS_FAULT; END_IF
    IF aNotReady[r] THEN wSts := wSts OR GVL_Const.RS_NOTREADY; END_IF
    IF xConflict THEN wSts := wSts OR GVL_Const.RS_CONFLICT; END_IF
    IF xAllRun THEN wSts := wSts OR GVL_Const.RS_ALLRUN; END_IF
    GVL_HMI.aHmiRoute[r].wSts := wSts;
    GVL_HMI.aHmiRoute[r].iState := GVL.aRouteState[r];
END_FOR
END_PROGRAM
