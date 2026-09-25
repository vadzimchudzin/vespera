FUNCTION F_SyncWord : BOOL
VAR_IN_OUT
    wHmi    : WORD;
    wPar    : WORD;
    wShadow : WORD;
END_VAR
IF wHmi <> wShadow THEN
    wPar := wHmi;
    F_SyncWord := TRUE;
END_IF
wHmi := wPar;
wShadow := wPar;
END_FUNCTION
