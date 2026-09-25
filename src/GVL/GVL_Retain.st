(* Уставки и моточасы. При необходимости сохранять их и при загрузке новой программы
   перенести эти переменные в список Persistent (VAR_GLOBAL PERSISTENT RETAIN). *)
VAR_GLOBAL RETAIN
    uInitMagic : UINT;
    stGlobPar  : ST_GlobPar;
    aMechPar   : ARRAY[1..GVL_Const.N_MECH] OF ST_MechPar;
    aValvePar  : ARRAY[1..GVL_Const.N_VALVE] OF ST_ValvePar;
    aBunkerPar : ARRAY[1..GVL_Const.N_BUNKER] OF ST_BunkerPar;
END_VAR
