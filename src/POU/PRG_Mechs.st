(* Вызов бункеров, клапанов и механизмов *)
PROGRAM PRG_Mechs
VAR
    i       : INT;
    aBunker : ARRAY[1..GVL_Const.N_BUNKER] OF FB_Bunker;
    aValve  : ARRAY[1..GVL_Const.N_VALVE] OF FB_Valve;
    aMech   : ARRAY[1..GVL_Const.N_MECH] OF FB_Mech;
    xAny    : BOOL;
    xNew    : BOOL;
END_VAR

xAny := FALSE;
xNew := FALSE;

FOR i := 1 TO GVL_Const.N_BUNKER DO
    aBunker[i](xHasSF := GVL_Const.BUNKER_HAS_SF[i],
               stIn := GVL.aBunkerIn[i],
               stHmi := GVL_HMI.aHmiBunker[i],
               stPar := GVL_Retain.aBunkerPar[i]);
    GVL.aBunkerFull[i] := aBunker[i].xFull;
    GVL.aBunkerAlarm[i] := aBunker[i].xAlarm;
    xAny := xAny OR aBunker[i].xAlarm;
    xNew := xNew OR aBunker[i].xNewAlarm;
END_FOR

FOR i := 1 TO GVL_Const.N_VALVE DO
    aValve[i](xHasSF := GVL_Const.VALVE_HAS_SF[i],
              stIn := GVL.aValveIn[i],
              iTarget := GVL.aValveTarget[i],
              xFlow := GVL.aRun[GVL_Const.VALVE_FEEDER[i]],
              stHmi := GVL_HMI.aHmiValve[i],
              stPar := GVL_Retain.aValvePar[i]);
    GVL.aValveOut[i] := aValve[i].stOut;
    GVL.aValvePos[i] := aValve[i].iPos;
    GVL.aValveReady[i] := aValve[i].xReady;
    GVL.aValveAlarm[i] := aValve[i].xAlarm;
    xAny := xAny OR aValve[i].xAlarm;
    xNew := xNew OR aValve[i].xNewAlarm;
END_FOR

FOR i := 1 TO GVL_Const.N_MECH DO
    aMech[i](stCfg := GVL_Const.MECH_CFG[i],
             stIn := GVL.aMechIn[i],
             xDemand := GVL.aDemand[i],
             xPredRun := GVL.aPredRun[i],
             xSuccOkAuto := GVL.aSuccAuto[i],
             xSuccOkMan := GVL.aSuccMan[i],
             xPaused := GVL.aBlocked[i],
             stHmi := GVL_HMI.aHmiMech[i],
             stPar := GVL_Retain.aMechPar[i]);
    GVL.aMechOut[i] := aMech[i].stOut;
    GVL.aRun[i] := aMech[i].xRun;
    GVL.aReady[i] := aMech[i].xReady;
    GVL.aAuto[i] := aMech[i].xAuto;
    GVL.aAlarm[i] := aMech[i].xAlarm;
    xAny := xAny OR aMech[i].xAlarm;
    xNew := xNew OR aMech[i].xNewAlarm;
END_FOR

GVL.xAnyAlarm := xAny;
GVL.xAnyNewAlarm := xNew;
END_PROGRAM
