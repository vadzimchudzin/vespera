TYPE ST_BunkerPar :
STRUCT
    wBypass   : WORD;   (* GVL_Const.BY_DVU - ДВУ отключен *)
    uTDvu     : UINT;   (* задержка срабатывания ДВУ, с *)
    uTRestart : UINT;   (* задержка повторного пуска после снятия ДВУ, с *)
END_STRUCT
END_TYPE
