(* 8 регистров, адрес = 1000 + (индекс-1)*8 *)
TYPE ST_ValveHmi :
STRUCT
    wCmd   : WORD;   (* +0 маски GVL_Const.VC_* *)
    wSts   : WORD;   (* +1 маски GVL_Const.VS_* *)
    wAlm   : WORD;   (* +2 маски GVL_Const.VA_* *)
    uTMove : UINT;   (* +3 контроль времени перевода, с *)
    uRes4  : UINT;
    uRes5  : UINT;
    uRes6  : UINT;
    uRes7  : UINT;
END_STRUCT
END_TYPE
