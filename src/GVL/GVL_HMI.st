(* Обмен с панелью Weintek cMT2166X по Modbus TCP (регистры хранения = %MW контроллера).
   Карта регистров - doc/HMI_map.md. *)
VAR_GLOBAL
    stHmiG     AT %MW0    : ST_GlobHmi;                                    (* %MW0..31 *)
    aHmiRoute  AT %MW100  : ARRAY[1..GVL_Const.N_ROUTE] OF ST_RouteHmi;    (* %MW100..143, по 4 *)
    aHmiMech   AT %MW200  : ARRAY[1..GVL_Const.N_MECH] OF ST_MechHmi;      (* %MW200..791, по 16 *)
    aHmiValve  AT %MW1000 : ARRAY[1..GVL_Const.N_VALVE] OF ST_ValveHmi;    (* %MW1000..1039, по 8 *)
    aHmiBunker AT %MW1100 : ARRAY[1..GVL_Const.N_BUNKER] OF ST_BunkerHmi;  (* %MW1100..1155, по 8 *)
END_VAR
