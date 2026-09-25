(* Блокировки по фактическим положениям клапанов:
   - aSuccAuto/aSuccMan - все механизмы, на которые подаёт данный, работают;
   - aPredRun - работает механизм, подающий на данный (удержание при останове);
   - aBlocked - полный бункер на выходе участка: пауза от бункера назад до головы участка. *)
PROGRAM PRG_Topology
VAR
    i    : INT;
    k    : INT;
    pass : INT;
    xStop : BOOL;
    xChg : BOOL;
END_VAR

GVL.nLinks := F_BuildLinks(aPos := GVL.aValvePos, aLinks := GVL.aLinks);

FOR i := 1 TO GVL_Const.N_MECH DO
    GVL.aSuccAuto[i] := TRUE;
    GVL.aSuccMan[i] := TRUE;
    GVL.aPredRun[i] := FALSE;
    GVL.aBlocked[i] := FALSE;
END_FOR

FOR k := 1 TO GVL.nLinks DO
    CASE GVL.aLinks[k].eTo OF
    GVL_Const.LT_MECH:
        IF NOT GVL.aRun[GVL.aLinks[k].iTo] THEN
            GVL.aSuccAuto[GVL.aLinks[k].iFrom] := FALSE;
            GVL.aSuccMan[GVL.aLinks[k].iFrom] := FALSE;
        END_IF
        IF GVL.aRun[GVL.aLinks[k].iFrom] THEN
            GVL.aPredRun[GVL.aLinks[k].iTo] := TRUE;
        END_IF
    GVL_Const.LT_BUNKER:
        (* в автомате полный бункер обрабатывается паузой участка (aBlocked) *)
        IF GVL.aBunkerFull[GVL.aLinks[k].iTo] OR GVL.aBunkerAlarm[GVL.aLinks[k].iTo] THEN
            GVL.aSuccMan[GVL.aLinks[k].iFrom] := FALSE;
        END_IF
    ELSE
        GVL.aSuccAuto[GVL.aLinks[k].iFrom] := FALSE;
        GVL.aSuccMan[GVL.aLinks[k].iFrom] := FALSE;
    END_CASE
END_FOR

(* пауза распространяется только по связям продукта и не проходит через бункеры *)
FOR pass := 1 TO GVL_Const.N_MECH DO
    xChg := FALSE;
    FOR k := 1 TO GVL.nLinks DO
        IF GVL.aLinks[k].xProduct AND NOT GVL.aBlocked[GVL.aLinks[k].iFrom] THEN
            (* CASE, а не AND: в ST операнды AND вычисляются оба, индекс iTo зависит от типа *)
            xStop := FALSE;
            CASE GVL.aLinks[k].eTo OF
            GVL_Const.LT_BUNKER: xStop := GVL.aBunkerFull[GVL.aLinks[k].iTo];
            GVL_Const.LT_MECH:   xStop := GVL.aBlocked[GVL.aLinks[k].iTo];
            END_CASE
            IF xStop THEN
                GVL.aBlocked[GVL.aLinks[k].iFrom] := TRUE;
                xChg := TRUE;
            END_IF
        END_IF
    END_FOR
    IF NOT xChg THEN
        EXIT;
    END_IF
END_FOR
END_PROGRAM
