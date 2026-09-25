(* Связи "кто на кого подаёт" при заданных положениях клапанов.
   Используется для блокировок (с фактическими положениями) и для определения состава
   маршрутов (с положениями из ROUTE_VALVE). Возвращает число связей. *)
FUNCTION F_BuildLinks : INT
VAR_IN_OUT
    aPos   : ARRAY[1..GVL_Const.N_VALVE] OF INT;
    aLinks : ARRAY[1..GVL_Const.N_LINK] OF ST_Link;
END_VAR
VAR
    n : INT;
END_VAR
VAR CONSTANT
    M : INT := 0;   (* LT_MECH *)
    B : INT := 1;   (* LT_BUNKER *)
    X : INT := 2;   (* LT_INVALID *)
END_VAR

(* ---- приёмное отделение и МУЗ ---- *)
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_GATE1, M, GVL_Const.M_N3, TRUE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_N3, B, GVL_Const.B_B4, TRUE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_MUZ5_FD, M, GVL_Const.M_MUZ5, TRUE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_MUZ5, M, GVL_Const.M_N7, TRUE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_MUZ5, M, GVL_Const.M_SH32, FALSE);    (* неиспользуемые отходы 32-31-30 *)
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_MUZ5, M, GVL_Const.M_KC35, FALSE);    (* используемые отходы 35-34 *)
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_MUZ5, M, GVL_Const.M_FAN6, FALSE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_FAN6, M, GVL_Const.M_SL6, FALSE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_N7, B, GVL_Const.B_B8, TRUE);

(* ---- ТОР-18 ---- *)
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_TOR9_FD, M, GVL_Const.M_TOR9, TRUE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_TOR9, M, GVL_Const.M_N11, TRUE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_TOR9, M, GVL_Const.M_SH31, FALSE);    (* неиспользуемые 31-30 *)
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_TOR9, M, GVL_Const.M_KC35, FALSE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_TOR9, M, GVL_Const.M_FAN10, FALSE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_FAN10, M, GVL_Const.M_SL10, FALSE);

(* нория 11 -> 12(1) -> TORBA 13(1) | 12(2) -> БТ | растариватель 15(1) -> нория 16 *)
CASE aPos[GVL_Const.V_V12_1] OF
1:
    n := n + 1; aLinks[n] := F_Link(GVL_Const.M_N11, B, GVL_Const.B_T13_1, TRUE);
2:
    CASE aPos[GVL_Const.V_V12_2] OF
    1:
        n := n + 1; aLinks[n] := F_Link(GVL_Const.M_N11, M, GVL_Const.M_BT14_1, TRUE);
        n := n + 1; aLinks[n] := F_Link(GVL_Const.M_N11, M, GVL_Const.M_BT14_2, TRUE);
    2:
        n := n + 1; aLinks[n] := F_Link(GVL_Const.M_N11, M, GVL_Const.M_N16, TRUE);
    ELSE
        n := n + 1; aLinks[n] := F_Link(GVL_Const.M_N11, X, 0, TRUE);
    END_CASE
ELSE
    n := n + 1; aLinks[n] := F_Link(GVL_Const.M_N11, X, 0, TRUE);
END_CASE

(* ---- блок триерный ---- *)
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_BT14_1, M, GVL_Const.M_N16, TRUE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_BT14_2, M, GVL_Const.M_N16, TRUE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_BT14_1, M, GVL_Const.M_KC36, FALSE);  (* отходы 36-35-34 *)
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_BT14_2, M, GVL_Const.M_KC36, FALSE);

(* нория 16 -> 12(3) -> бункер 17 (КСП) | нория 20 *)
CASE aPos[GVL_Const.V_V12_3] OF
1:
    n := n + 1; aLinks[n] := F_Link(GVL_Const.M_N16, B, GVL_Const.B_B17, TRUE);
2:
    n := n + 1; aLinks[n] := F_Link(GVL_Const.M_N16, M, GVL_Const.M_N20, TRUE);
ELSE
    n := n + 1; aLinks[n] := F_Link(GVL_Const.M_N16, X, 0, TRUE);
END_CASE

(* ---- КСП-11М ---- *)
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_KSP18_FD, M, GVL_Const.M_KSP18, TRUE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_KSP18, M, GVL_Const.M_N20, TRUE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_KSP18, M, GVL_Const.M_SH33, FALSE);   (* неиспользуемые 33-31-30 *)
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_KSP18, M, GVL_Const.M_KC35, FALSE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_KSP18, M, GVL_Const.M_FAN19, FALSE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_FAN19, M, GVL_Const.M_SL19, FALSE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_N20, B, GVL_Const.B_B22, TRUE);

(* нория 21 -> 12(4) -> бункер 22 (СП) | Z-нория 26 *)
CASE aPos[GVL_Const.V_V12_4] OF
1:
    n := n + 1; aLinks[n] := F_Link(GVL_Const.M_N21, B, GVL_Const.B_B22, TRUE);
2:
    n := n + 1; aLinks[n] := F_Link(GVL_Const.M_N21, M, GVL_Const.M_ZN26, TRUE);
ELSE
    n := n + 1; aLinks[n] := F_Link(GVL_Const.M_N21, X, 0, TRUE);
END_CASE

(* ---- СП-200 ---- *)
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_SP24_DRV, M, GVL_Const.M_ZN26, TRUE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_SP24_DRV, M, GVL_Const.M_KC36, FALSE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_SP24_DRV, M, GVL_Const.M_SP24_FAN, FALSE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_SP24_FAN, M, GVL_Const.M_FAN25, FALSE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_FAN25, M, GVL_Const.M_SL25, FALSE);

(* Z-нория 26 -> выгрузка включена: TORBA 13(2) | выключена: бункер фотосепаратора *)
CASE aPos[GVL_Const.V_V49] OF
1:
    n := n + 1; aLinks[n] := F_Link(GVL_Const.M_ZN26, B, GVL_Const.B_T13_2, TRUE);
2:
    n := n + 1; aLinks[n] := F_Link(GVL_Const.M_ZN26, B, GVL_Const.B_B27, TRUE);
ELSE
    n := n + 1; aLinks[n] := F_Link(GVL_Const.M_ZN26, X, 0, TRUE);
END_CASE

(* ---- фотосепаратор (отходы - напрямую в рамку Биг-Бег) ---- *)
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_FS27, M, GVL_Const.M_ZN29, TRUE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_FS27, M, GVL_Const.M_FAN28, FALSE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_FAN28, M, GVL_Const.M_SL28, FALSE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_ZN29, B, GVL_Const.B_T13_2, TRUE);

(* ---- конвейеры отходов ---- *)
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_SH32, M, GVL_Const.M_SH31, FALSE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_SH33, M, GVL_Const.M_SH31, FALSE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_SH31, M, GVL_Const.M_SH30, FALSE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_KC36, M, GVL_Const.M_KC35, FALSE);
n := n + 1; aLinks[n] := F_Link(GVL_Const.M_KC35, M, GVL_Const.M_KC34, FALSE);

F_BuildLinks := n;
END_FUNCTION
