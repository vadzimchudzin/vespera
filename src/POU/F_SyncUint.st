(* Уставка в RETAIN <-> регистр панели.
   Если панель изменила регистр (он отличается от последнего выданного значения) -
   принять новое значение с ограничением, затем выдать уставку обратно в регистр. *)
FUNCTION F_SyncUint : BOOL
VAR_INPUT
    uMax : UINT;
END_VAR
VAR_IN_OUT
    uHmi    : UINT;
    uPar    : UINT;
    uShadow : UINT;
END_VAR
IF uHmi <> uShadow THEN
    uPar := MIN(uHmi, uMax);
    F_SyncUint := TRUE;
END_IF
uHmi := uPar;
uShadow := uPar;
END_FUNCTION
