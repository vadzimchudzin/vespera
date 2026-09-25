(* Константы проекта ЕФБШ-649.01-АТХ, ЛПЗС-5 ССЦ "Золотой початок".
   Номера позиций "поз." - по технологической схеме (Приложение 1). *)
VAR_GLOBAL CONSTANT
    N_MECH   : INT := 37;
    N_VALVE  : INT := 5;
    N_BUNKER : INT := 7;
    N_ROUTE  : INT := 11;
    N_LINK   : INT := 64;
    N_HEAD   : INT := 6;

    (* ---- механизмы (индекс = номер в панели) ---- *)
    M_GATE1    : INT := 1;   (* заслонка бункера растаривания поз.1, ПЧ 51UZ1 *)
    M_N3       : INT := 2;   (* нория поз.3 *)
    M_MUZ5_FD  : INT := 3;   (* МУЗ-8М поз.5 - битер (питатель), ПЧ 5UZ1 *)
    M_MUZ5     : INT := 4;   (* МУЗ-8М поз.5 - основной двигатель *)
    M_FAN6     : INT := 5;   (* вентилятор аспирации поз.6 *)
    M_SL6      : INT := 6;   (* шлюзовой затвор поз.6 *)
    M_N7       : INT := 7;   (* нория поз.7 *)
    M_TOR9_FD  : INT := 8;   (* ТОР-18 поз.9 - двигатель 0,75 кВт, ПЧ 11UZ1 *)
    M_TOR9     : INT := 9;   (* ТОР-18 поз.9 - основной двигатель *)
    M_FAN10    : INT := 10;  (* вентилятор аспирации поз.10 *)
    M_SL10     : INT := 11;  (* шлюзовой затвор поз.10 *)
    M_N11      : INT := 12;  (* нория поз.11 *)
    M_BT14_1   : INT := 13;  (* блок триерный БТ-9/2 поз.14 - двигатель 1, ПЧ 24UZ1 *)
    M_BT14_2   : INT := 14;  (* блок триерный БТ-9/2 поз.14 - двигатель 2, ПЧ 25UZ1 *)
    M_N16      : INT := 15;  (* нория поз.16 *)
    M_KSP18_FD : INT := 16;  (* КСП-11М поз.18 - битер (питатель), ПЧ 29UZ1 *)
    M_KSP18    : INT := 17;  (* КСП-11М поз.18 - основной двигатель *)
    M_FAN19    : INT := 18;  (* вентилятор аспирации поз.19 *)
    M_SL19     : INT := 19;  (* шлюзовой затвор поз.19 *)
    M_N20      : INT := 20;  (* нория поз.20 *)
    M_N21      : INT := 21;  (* нория поз.21 *)
    M_SP24_DRV : INT := 22;  (* СП-200 поз.24 - привод деки, ПЧ 36UZ1 *)
    M_SP24_FAN : INT := 23;  (* СП-200 поз.24 - вентилятор стола 11 кВт (звезда-треугольник) *)
    M_FAN25    : INT := 24;  (* вентилятор аспирации поз.25 *)
    M_SL25     : INT := 25;  (* шлюзовой затвор поз.25 *)
    M_ZN26     : INT := 26;  (* Z-нория поз.26, ПЧ 48UZ1 *)
    M_FS27     : INT := 27;  (* фотосепаратор СмартСорт поз.27 *)
    M_FAN28    : INT := 28;  (* вентилятор аспирации поз.28 *)
    M_SL28     : INT := 29;  (* шлюзовой затвор поз.28 *)
    M_ZN29     : INT := 30;  (* Z-нория поз.29, ПЧ 50UZ1 *)
    M_SH30     : INT := 31;  (* конвейер шнековый КШ-4-150 поз.30 *)
    M_SH31     : INT := 32;  (* конвейер шнековый КШU-150 поз.31 *)
    M_SH32     : INT := 33;  (* конвейер шнековый КШU-150 поз.32 *)
    M_SH33     : INT := 34;  (* конвейер шнековый КШU-150 поз.33 *)
    M_KC34     : INT := 35;  (* конвейер цепной КЦСВ поз.34 *)
    M_KC35     : INT := 36;  (* конвейер цепной КЦСН поз.35 *)
    M_KC36     : INT := 37;  (* конвейер цепной КЦСН поз.36 *)

    (* ---- переключатели потока (положение 1 / положение 2) ---- *)
    V_V12_1 : INT := 1;   (* поз.12(1): 1 - на TORBA поз.13(1),  2 - на поз.12(2) *)
    V_V12_2 : INT := 2;   (* поз.12(2): 1 - на БТ поз.14,         2 - на растариватель 15(1) -> нория 16 *)
    V_V12_3 : INT := 3;   (* поз.12(3): 1 - на бункер поз.17 (КСП), 2 - на норию поз.20 *)
    V_V12_4 : INT := 4;   (* поз.12(4): 1 - на бункер поз.22 (СП),  2 - на Z-норию поз.26 *)
    V_V49   : INT := 5;   (* выгрузка Z-нории поз.26: 1 - включена (на TORBA 13(2)), 2 - выключена (на ФС поз.27) *)

    (* ---- бункеры ---- *)
    B_B4    : INT := 1;   (* бункер оперативный поз.4 *)
    B_B8    : INT := 2;   (* бункер оперативный поз.8 *)
    B_B17   : INT := 3;   (* бункер оперативный поз.17 *)
    B_B22   : INT := 4;   (* бункер оперативный поз.22 *)
    B_B27   : INT := 5;   (* приёмный бункер фотосепаратора поз.27 *)
    B_T13_1 : INT := 6;   (* станция затаривания TORBA-1000 поз.13(1) *)
    B_T13_2 : INT := 7;   (* станция затаривания TORBA-1000 поз.13(2) *)

    (* ---- типы механизмов ---- *)
    K_DOL  : INT := 0;    (* прямой пуск *)
    K_FC   : INT := 1;    (* частотный преобразователь: питание, пуск, сброс *)
    K_GATE : INT := 2;    (* заслонка с ПЧ: открыть/закрыть, концевики *)
    K_FS   : INT := 3;    (* фотосепаратор: импульсы вкл/выкл, разрешение секций *)

    DKS_NONE  : INT := 0;
    DKS_PULSE : INT := 1; (* индуктивный датчик, импульсы *)
    DKS_LEVEL : INT := 2; (* реле движения РДД-03, уровень 1 = движение есть *)

    MODE_AUTO  : INT := 0;
    MODE_MAN   : INT := 1;
    MODE_LOCAL : INT := 2;

    LT_MECH    : INT := 0;
    LT_BUNKER  : INT := 1;
    LT_INVALID : INT := 2; (* клапан не в положении - подача не определена *)

    RST_IDLE     : INT := 0;
    RST_PRESTART : INT := 1;
    RST_VALVES   : INT := 2;
    RST_RUN      : INT := 3;
    RST_STOPPING : INT := 4;

    (* ---- полярность датчиков (проверить при ПНР) ---- *)
    CFG_DSL_OK      : BOOL := TRUE;   (* ДСЛ И25-NO/NC: 1 = лента в норме *)
    CFG_DP_OK       : BOOL := TRUE;   (* ДП норий Е13-NC: 1 = подпора нет *)
    CFG_DP_SCREW_OK : BOOL := TRUE;   (* ДП шнеков, концевик EMAS: 1 = подпора нет *)
    CFG_DP_CHAIN_OK : BOOL := FALSE;  (* ДП цепных конвейеров через реле РСУ-4 (KM3 13-14): 1 = подпор *)
    CFG_DVU_FULL    : BOOL := TRUE;   (* ДВУ через промежуточное реле: 1 = бункер полон *)
    CFG_DNU_ON      : BOOL := TRUE;   (* ДНУ: 1 = продукт есть *)
    CFG_FC_FAULT    : BOOL := TRUE;   (* реле аварии ПЧ Hope530 (1TA-1TC): 1 = авария *)
    CFG_SA_LOCAL    : BOOL := TRUE;   (* ключ поста "Автом./ручн." (11-14): 1 = ручн. (местное) *)

    (* ---- команды механизма (ST_MechHmi.wCmd) ---- *)
    C_START    : WORD := 16#0001;   (* пуск в ручном режиме, импульс *)
    C_STOP     : WORD := 16#0002;   (* стоп в ручном режиме, импульс *)
    C_MANUAL   : WORD := 16#0004;   (* 1 = ручной режим с панели, 0 = автомат *)
    C_RESET_TO : WORD := 16#0008;   (* сброс счётчика ТО, импульс *)
    C_OPEN     : WORD := 16#0010;   (* заслонка: открывать, пока нажато *)
    C_CLOSE    : WORD := 16#0020;   (* заслонка: закрывать, пока нажато *)

    (* ---- состояние механизма (ST_MechHmi.wSts) ---- *)
    S_RUN      : WORD := 16#0001;
    S_CMD      : WORD := 16#0002;
    S_READY    : WORD := 16#0004;
    S_ALARM    : WORD := 16#0008;
    S_LOCAL    : WORD := 16#0010;
    S_MANUAL   : WORD := 16#0020;
    S_SETUP    : WORD := 16#0040;
    S_STARTING : WORD := 16#0080;
    S_STOPPING : WORD := 16#0100;
    S_DEMAND   : WORD := 16#0200;
    S_PAUSE    : WORD := 16#0400;
    S_TO_DUE   : WORD := 16#0800;
    S_OPENED   : WORD := 16#1000;
    S_CLOSED   : WORD := 16#2000;
    S_SEQ_TRIP : WORD := 16#4000;   (* остановлен блокировкой: встал последующий механизм *)
    S_SUCC_OK  : WORD := 16#8000;   (* последующие механизмы в работе - ручной пуск разрешён *)

    (* ---- аварии механизма (ST_MechHmi.wAlm) ---- *)
    A_QF      : WORD := 16#0001;    (* защита двигателя / ПЧ *)
    A_DKS     : WORD := 16#0002;    (* нет вращения (ДКС) *)
    A_DSL1    : WORD := 16#0004;    (* сбег ленты 1 *)
    A_DSL2    : WORD := 16#0008;    (* сбег ленты 2 *)
    A_DP      : WORD := 16#0010;    (* подпор *)
    A_ESTOP   : WORD := 16#0020;    (* аварийный / концевой стоп у механизма *)
    A_LOCSTOP : WORD := 16#0040;    (* нажат местный "Стоп" при работе от панели *)
    A_FC      : WORD := 16#0080;    (* авария ПЧ *)
    A_FCFB    : WORD := 16#0100;    (* нет сигнала работы ПЧ *)
    A_MOVE    : WORD := 16#0200;    (* заслонка не дошла за заданное время *)
    A_POS     : WORD := 16#0400;    (* заслонка: оба концевика *)
    A_FSERR   : WORD := 16#0800;    (* фотосепаратор: критическая ошибка *)
    A_FSFB    : WORD := 16#1000;    (* фотосепаратор: нет статуса работы *)
    A_HARD    : WORD := 16#08A1;    (* аварии, которые не отключаются в режиме наладки: QF, ESTOP, FC, FSERR *)

    (* ---- отключение датчиков (ST_MechHmi.wBypass / ST_BunkerHmi.wBypass) ---- *)
    BY_DKS  : WORD := 16#0001;
    BY_DSL1 : WORD := 16#0002;
    BY_DSL2 : WORD := 16#0004;
    BY_DP   : WORD := 16#0008;
    BY_AUX  : WORD := 16#0010;      (* фотосепаратор: не требовать работу компрессора *)
    BY_DVU  : WORD := 16#0001;      (* бункер: ДВУ отключен *)

    (* ---- переключатели потока ---- *)
    VC_POS1   : WORD := 16#0001;    (* перевести в положение 1, импульс (ручной режим) *)
    VC_POS2   : WORD := 16#0002;
    VC_MANUAL : WORD := 16#0004;
    VS_POS1   : WORD := 16#0001;
    VS_POS2   : WORD := 16#0002;
    VS_MOVING : WORD := 16#0004;
    VS_ALARM  : WORD := 16#0008;
    VS_MANUAL : WORD := 16#0010;
    VS_ROUTE  : WORD := 16#0020;    (* положение задано маршрутом *)
    VS_FLOW   : WORD := 16#0040;    (* подающий механизм работает - ручной перевод запрещён *)
    VA_SF      : WORD := 16#0001;
    VA_TIMEOUT : WORD := 16#0002;
    VA_BOTH    : WORD := 16#0004;

    (* ---- бункеры ---- *)
    BS_DVU    : WORD := 16#0001;    (* ДВУ сработал (без задержки) *)
    BS_FULL   : WORD := 16#0002;    (* бункер полон - пауза подачи *)
    BS_DNU    : WORD := 16#0004;
    BS_BYPASS : WORD := 16#0008;
    BS_ALARM  : WORD := 16#0010;
    BA_SF     : WORD := 16#0001;    (* TORBA: отключен автомат пульта управления *)

    (* ---- маршруты ---- *)
    RC_TOGGLE : WORD := 16#0001;    (* "ПУСК" / повторное нажатие - "СТОП" *)
    RC_STOP   : WORD := 16#0002;
    RS_ACTIVE   : WORD := 16#0001;
    RS_PRESTART : WORD := 16#0002;
    RS_VALVES   : WORD := 16#0004;
    RS_RUN      : WORD := 16#0008;
    RS_STOPPING : WORD := 16#0010;
    RS_PAUSED   : WORD := 16#0020;
    RS_FAULT    : WORD := 16#0040;
    RS_NOTREADY : WORD := 16#0080;
    RS_CONFLICT : WORD := 16#0100;
    RS_ALLRUN   : WORD := 16#0200;

    (* ---- общий блок ---- *)
    G_RESET   : WORD := 16#0001;    (* сброс аварий, импульс (после подтверждения на панели) *)
    G_MUTE    : WORD := 16#0002;    (* отключить звук сирены, импульс *)
    G_SETUP   : WORD := 16#0004;    (* режим наладки (панель выставляет после ввода пароля) *)
    G_STOPALL : WORD := 16#0008;    (* остановить все маршруты, импульс *)
    GS_SYSON    : WORD := 16#0001;  (* цепь управления включена (1K1) *)
    GS_OK       : WORD := 16#0002;  (* нет общих аварий *)
    GS_ALARM    : WORD := 16#0004;  (* есть активные аварии *)
    GS_SIREN    : WORD := 16#0008;
    GS_SETUP    : WORD := 16#0010;
    GS_PRESTART : WORD := 16#0020;
    GA_FIRE  : WORD := 16#0400;
    GA_PHASE : WORD := 16#0800;
    GW_COMPR  : WORD := 16#0001;    (* отключен автомат компрессора 57SF1 *)
    GW_COMPR2 : WORD := 16#0002;    (* 58QF1 (опция) *)
    GW_DRYER  : WORD := 16#0004;    (* 56SF1 (опция) *)
    GW_FSASP  : WORD := 16#0008;    (* 53SF1 питание аспирации ФС (опция) *)
    GW_SYSOFF : WORD := 16#0010;    (* цепь управления отключена *)

    T_MAX_S  : UINT := 3600;
    RETAIN_MAGIC : UINT := 16#6491;

    (* ---- конфигурация механизмов ---- *)
    MECH_CFG : ARRAY[1..37] OF ST_MechCfg := [
        (eKind := 2, xHasQF := TRUE, eDks := 0, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := TRUE,  xHasEStop := FALSE, uDefTOn := 2,  uDefTOff := 0),   (* 1  заслонка поз.1 *)
        (eKind := 0, xHasQF := TRUE, eDks := 1, xHasDSL := TRUE,  xHasDP := TRUE,  xHasLocal := TRUE,  xHasEStop := TRUE,  uDefTOn := 3,  uDefTOff := 10),  (* 2  нория поз.3 *)
        (eKind := 1, xHasQF := TRUE, eDks := 0, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := FALSE, xHasEStop := TRUE,  uDefTOn := 3,  uDefTOff := 0),   (* 3  битер МУЗ *)
        (eKind := 0, xHasQF := TRUE, eDks := 0, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := FALSE, xHasEStop := FALSE, uDefTOn := 5,  uDefTOff := 15),  (* 4  МУЗ-8М *)
        (eKind := 0, xHasQF := TRUE, eDks := 0, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := FALSE, xHasEStop := FALSE, uDefTOn := 5,  uDefTOff := 30),  (* 5  вентилятор поз.6 *)
        (eKind := 0, xHasQF := TRUE, eDks := 1, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := FALSE, xHasEStop := FALSE, uDefTOn := 3,  uDefTOff := 40),  (* 6  шлюз поз.6 *)
        (eKind := 0, xHasQF := TRUE, eDks := 1, xHasDSL := TRUE,  xHasDP := TRUE,  xHasLocal := TRUE,  xHasEStop := TRUE,  uDefTOn := 3,  uDefTOff := 10),  (* 7  нория поз.7 *)
        (eKind := 1, xHasQF := TRUE, eDks := 0, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := FALSE, xHasEStop := TRUE,  uDefTOn := 3,  uDefTOff := 0),   (* 8  ПЧ ТОР-18 *)
        (eKind := 0, xHasQF := TRUE, eDks := 0, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := FALSE, xHasEStop := FALSE, uDefTOn := 5,  uDefTOff := 15),  (* 9  ТОР-18 *)
        (eKind := 0, xHasQF := TRUE, eDks := 0, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := FALSE, xHasEStop := FALSE, uDefTOn := 5,  uDefTOff := 30),  (* 10 вентилятор поз.10 *)
        (eKind := 0, xHasQF := TRUE, eDks := 1, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := FALSE, xHasEStop := FALSE, uDefTOn := 3,  uDefTOff := 40),  (* 11 шлюз поз.10 *)
        (eKind := 0, xHasQF := TRUE, eDks := 1, xHasDSL := TRUE,  xHasDP := TRUE,  xHasLocal := TRUE,  xHasEStop := TRUE,  uDefTOn := 3,  uDefTOff := 10),  (* 12 нория поз.11 *)
        (eKind := 1, xHasQF := TRUE, eDks := 0, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := FALSE, xHasEStop := TRUE,  uDefTOn := 5,  uDefTOff := 15),  (* 13 БТ-9/2 двигатель 1 *)
        (eKind := 1, xHasQF := TRUE, eDks := 0, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := FALSE, xHasEStop := TRUE,  uDefTOn := 5,  uDefTOff := 15),  (* 14 БТ-9/2 двигатель 2 *)
        (eKind := 0, xHasQF := TRUE, eDks := 1, xHasDSL := TRUE,  xHasDP := TRUE,  xHasLocal := TRUE,  xHasEStop := TRUE,  uDefTOn := 3,  uDefTOff := 10),  (* 15 нория поз.16 *)
        (eKind := 1, xHasQF := TRUE, eDks := 0, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := FALSE, xHasEStop := TRUE,  uDefTOn := 3,  uDefTOff := 0),   (* 16 битер КСП *)
        (eKind := 0, xHasQF := TRUE, eDks := 0, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := FALSE, xHasEStop := FALSE, uDefTOn := 5,  uDefTOff := 15),  (* 17 КСП-11М *)
        (eKind := 0, xHasQF := TRUE, eDks := 0, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := FALSE, xHasEStop := FALSE, uDefTOn := 5,  uDefTOff := 30),  (* 18 вентилятор поз.19 *)
        (eKind := 0, xHasQF := TRUE, eDks := 1, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := FALSE, xHasEStop := FALSE, uDefTOn := 3,  uDefTOff := 40),  (* 19 шлюз поз.19 *)
        (eKind := 0, xHasQF := TRUE, eDks := 1, xHasDSL := TRUE,  xHasDP := TRUE,  xHasLocal := TRUE,  xHasEStop := TRUE,  uDefTOn := 3,  uDefTOff := 10),  (* 20 нория поз.20 *)
        (eKind := 0, xHasQF := TRUE, eDks := 1, xHasDSL := TRUE,  xHasDP := TRUE,  xHasLocal := TRUE,  xHasEStop := TRUE,  uDefTOn := 3,  uDefTOff := 10),  (* 21 нория поз.21 *)
        (eKind := 1, xHasQF := TRUE, eDks := 0, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := FALSE, xHasEStop := TRUE,  uDefTOn := 5,  uDefTOff := 10),  (* 22 СП-200 привод *)
        (eKind := 0, xHasQF := TRUE, eDks := 0, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := FALSE, xHasEStop := FALSE, uDefTOn := 10, uDefTOff := 15),  (* 23 СП-200 вентилятор *)
        (eKind := 0, xHasQF := TRUE, eDks := 0, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := FALSE, xHasEStop := FALSE, uDefTOn := 5,  uDefTOff := 30),  (* 24 вентилятор поз.25 *)
        (eKind := 0, xHasQF := TRUE, eDks := 1, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := FALSE, xHasEStop := FALSE, uDefTOn := 3,  uDefTOff := 40),  (* 25 шлюз поз.25 *)
        (eKind := 1, xHasQF := TRUE, eDks := 1, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := TRUE,  xHasEStop := TRUE,  uDefTOn := 3,  uDefTOff := 10),  (* 26 Z-нория поз.26 *)
        (eKind := 3, xHasQF := TRUE, eDks := 0, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := FALSE, xHasEStop := FALSE, uDefTOn := 5,  uDefTOff := 10),  (* 27 фотосепаратор *)
        (eKind := 0, xHasQF := TRUE, eDks := 0, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := FALSE, xHasEStop := FALSE, uDefTOn := 5,  uDefTOff := 30),  (* 28 вентилятор поз.28 *)
        (eKind := 0, xHasQF := TRUE, eDks := 1, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := FALSE, xHasEStop := FALSE, uDefTOn := 3,  uDefTOff := 40),  (* 29 шлюз поз.28 *)
        (eKind := 1, xHasQF := TRUE, eDks := 1, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := TRUE,  xHasEStop := TRUE,  uDefTOn := 3,  uDefTOff := 10),  (* 30 Z-нория поз.29 *)
        (eKind := 0, xHasQF := TRUE, eDks := 0, xHasDSL := FALSE, xHasDP := FALSE, xHasLocal := TRUE,  xHasEStop := TRUE,  uDefTOn := 3,  uDefTOff := 30),  (* 31 шнек поз.30 (ДКС, ДП - опция) *)
        (eKind := 0, xHasQF := TRUE, eDks := 1, xHasDSL := FALSE, xHasDP := TRUE,  xHasLocal := TRUE,  xHasEStop := TRUE,  uDefTOn := 3,  uDefTOff := 30),  (* 32 шнек поз.31 *)
        (eKind := 0, xHasQF := TRUE, eDks := 1, xHasDSL := FALSE, xHasDP := TRUE,  xHasLocal := TRUE,  xHasEStop := TRUE,  uDefTOn := 3,  uDefTOff := 30),  (* 33 шнек поз.32 *)
        (eKind := 0, xHasQF := TRUE, eDks := 1, xHasDSL := FALSE, xHasDP := TRUE,  xHasLocal := TRUE,  xHasEStop := TRUE,  uDefTOn := 3,  uDefTOff := 30),  (* 34 шнек поз.33 *)
        (eKind := 0, xHasQF := TRUE, eDks := 2, xHasDSL := FALSE, xHasDP := TRUE,  xHasLocal := TRUE,  xHasEStop := TRUE,  uDefTOn := 3,  uDefTOff := 30),  (* 35 цепной поз.34 *)
        (eKind := 0, xHasQF := TRUE, eDks := 2, xHasDSL := FALSE, xHasDP := TRUE,  xHasLocal := TRUE,  xHasEStop := TRUE,  uDefTOn := 3,  uDefTOff := 30),  (* 36 цепной поз.35 *)
        (eKind := 0, xHasQF := TRUE, eDks := 2, xHasDSL := FALSE, xHasDP := TRUE,  xHasLocal := TRUE,  xHasEStop := TRUE,  uDefTOn := 3,  uDefTOff := 30)   (* 37 цепной поз.36 *)
    ];

    (* ---- маршруты (Приложение 5) ----
       1  Очистка: воронка - ... - БТ - нория 16 - нория 20 - СП - Z26 - ФС - Z29 - TORBA 13(2) (мимо КСП)
       2  Очистка мимо БТ (через КСП)
       3  Очистка мимо БТ и КСП
       4  Очистка мимо КСП и фотосепаратора
       5  Очистка мимо БТ, КСП и фотосепаратора
       6  Воронка - ... - ТОР - нория 11 - TORBA 13(1)
       7  Растариватель 15(1) - нория 16 - КСП - нория 20 - СП - Z26 - ФС - Z29 - TORBA 13(2)
       8  Растариватель 15(1) - нория 16 - КСП - нория 20 - СП - Z26 - TORBA 13(2)
       9  Растариватель 15(2) - нория 21 - СП - Z26 - ФС - Z29 - TORBA 13(2)
       10 Растариватель 15(2) - нория 21 - СП - Z26 - TORBA 13(2)
       11 Растариватель 15(2) - нория 21 - Z26 - ФС - Z29 - TORBA 13(2)
       Головные механизмы участков (от которых по связям определяется состав маршрута):
       1 заслонка, 3 битер МУЗ, 8 ПЧ ТОР, 15 нория 16, 16 битер КСП, 21 нория 21, 22 привод СП, 27 ФС *)
    ROUTE_HEAD : ARRAY[1..11, 1..6] OF INT := [
        1, 3, 8, 22, 27, 0,
        1, 3, 8, 16, 22, 27,
        1, 3, 8, 22, 27, 0,
        1, 3, 8, 22, 0, 0,
        1, 3, 8, 22, 0, 0,
        1, 3, 8, 0, 0, 0,
        15, 16, 22, 27, 0, 0,
        15, 16, 22, 0, 0, 0,
        21, 22, 27, 0, 0, 0,
        21, 22, 0, 0, 0, 0,
        21, 27, 0, 0, 0, 0
    ];
    (* положения клапанов: 12(1), 12(2), 12(3), 12(4), выгрузка Z26; 0 = не участвует *)
    ROUTE_VALVE : ARRAY[1..11, 1..5] OF INT := [
        2, 1, 2, 0, 2,
        2, 2, 1, 0, 2,
        2, 2, 2, 0, 2,
        2, 1, 2, 0, 1,
        2, 2, 2, 0, 1,
        1, 0, 0, 0, 0,
        0, 0, 1, 0, 2,
        0, 0, 1, 0, 1,
        0, 0, 0, 1, 2,
        0, 0, 0, 1, 1,
        0, 0, 0, 2, 2
    ];
    (* запреты одновременного пуска (Приложение 5), TRUE = запрет *)
    ROUTE_CONFLICT : ARRAY[1..11, 1..11] OF BOOL := [
        55(TRUE),
        5(TRUE), 6(FALSE),
        5(TRUE), FALSE, 5(TRUE),
        5(TRUE), FALSE, 5(TRUE),
        5(TRUE), FALSE, 5(TRUE),
        5(TRUE), FALSE, 5(TRUE),
        5(TRUE), FALSE, 5(TRUE)
    ];

    (* механизм, подающий продукт на клапан (при его работе ручной перевод запрещён) *)
    VALVE_FEEDER : ARRAY[1..5] OF INT := [12, 12, 15, 21, 26];
    VALVE_HAS_SF : ARRAY[1..5] OF BOOL := [TRUE, TRUE, TRUE, TRUE, FALSE];
    BUNKER_HAS_SF : ARRAY[1..7] OF BOOL := [FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, TRUE];
END_VAR
