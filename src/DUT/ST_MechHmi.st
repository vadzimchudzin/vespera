(* Обмен с панелью по механизму: 16 регистров %MW (только 16-битные поля).
   Адрес = 200 + (индекс-1)*16 + смещение. *)
TYPE ST_MechHmi :
STRUCT
    wCmd           : WORD;  (* +0  команды панели, маски GVL_Const.C_* *)
    wSts           : WORD;  (* +1  состояние, маски GVL_Const.S_* *)
    wAlm           : WORD;  (* +2  аварии (с фиксацией), маски GVL_Const.A_* *)
    wBypass        : WORD;  (* +3  отключение датчиков (запись с паролем) *)
    uTOn           : UINT;  (* +4  задержка пуска, с *)
    uTOff          : UINT;  (* +5  задержка останова, с *)
    uToInterval    : UINT;  (* +6  интервал ТО, ч *)
    uHoursSinceTO  : UINT;  (* +7  наработка после ТО, ч *)
    uHoursTotal    : UINT;  (* +8  наработка всего, ч *)
    uMinutes       : UINT;  (* +9  минуты наработки (0..59) *)
    iState         : INT;   (* +10 0 стоп, 1 пуск, 2 работа, 3 останов, 4 авария, 5 местное *)
    uRes11         : UINT;
    uRes12         : UINT;
    uRes13         : UINT;
    uRes14         : UINT;
    uRes15         : UINT;
END_STRUCT
END_TYPE
