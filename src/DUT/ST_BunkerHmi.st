(* 8 регистров, адрес = 1100 + (индекс-1)*8 *)
TYPE ST_BunkerHmi :
STRUCT
    wSts      : WORD;   (* +0 маски GVL_Const.BS_* *)
    wAlm      : WORD;   (* +1 GVL_Const.BA_SF *)
    wBypass   : WORD;   (* +2 GVL_Const.BY_DVU *)
    uTDvu     : UINT;   (* +3 с *)
    uTRestart : UINT;   (* +4 с *)
    uRes5     : UINT;
    uRes6     : UINT;
    uRes7     : UINT;
END_STRUCT
END_TYPE
