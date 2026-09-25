# -*- coding: utf-8 -*-
# ЕФБШ-649.01-АТХ: привязка каналов ввода-вывода к переменным GVL_IO.
# Сгенерировано gen/gen_iomap_script.py из doc/IO_map.csv.
#
# Запуск: Machine Expert -> Инструменты -> Скрипты -> Выполнить файл сценария -> map_io.py
# (проект с контроллером и модулями открыт, PLCopenXML уже импортирован).
# Первый запуск с APPLY = False только печатает план в окно сообщений. Если план верный -
# поставить APPLY = True, запустить ещё раз, сохранить проект.
from __future__ import print_function

APPLY = False
APP = u"Application"          # имя приложения в дереве устройств

# (модуль по Э3, I/Q, номер канала, переменная)
MAP = [
    (u'A1', u'I', 0, u'DI_SYS_ON'),
    (u'A1', u'I', 1, u'DI_ESTOP_1'),
    (u'A1', u'I', 2, u'DI_ESTOP_2'),
    (u'A1', u'I', 3, u'DI_ESTOP_3'),
    (u'A1', u'I', 4, u'DI_ESTOP_4'),
    (u'A1', u'I', 5, u'DI_ESTOP_5'),
    (u'A1', u'I', 6, u'DI_ESTOP_6'),
    (u'A1', u'I', 7, u'DI_ESTOP_7'),
    (u'A1', u'I', 8, u'DI_ESTOP_8'),
    (u'A1', u'I', 9, u'DI_ESTOP_9'),
    (u'A1', u'I', 10, u'DI_ESTOP_10'),
    (u'A1', u'I', 11, u'DI_FIRE_OK'),
    (u'A1', u'I', 12, u'DI_PHASE_OK'),
    (u'A1', u'I', 13, u'DI_A1_I13_RES'),
    (u'A1', u'I', 14, u'DI_N3_DKS'),
    (u'A1', u'I', 15, u'DI_N3_DSL1'),
    (u'A1', u'I', 16, u'DI_N3_DSL2'),
    (u'A1', u'I', 17, u'DI_N3_DP'),
    (u'A1', u'I', 18, u'DI_N3_SA'),
    (u'A1', u'I', 19, u'DI_N3_SB_START'),
    (u'A1', u'I', 20, u'DI_N3_SB_STOP'),
    (u'A1', u'I', 21, u'DI_N3_SB_ESTOP'),
    (u'A1', u'I', 22, u'DI_N3_QF'),
    (u'A1', u'I', 23, u'DI_B4_DVU'),
    (u'A1.1', u'I', 0, u'DI_B4_DNU'),
    (u'A1.1', u'I', 1, u'DI_MUZ5_QF'),
    (u'A1.1', u'I', 2, u'DI_MUZ5FD_SF'),
    (u'A1.1', u'I', 3, u'DI_MUZ5FD_FAULT'),
    (u'A1.1', u'I', 4, u'DI_MUZ5FD_READY'),
    (u'A1.1', u'I', 5, u'DI_MUZ5FD_ESTOP'),
    (u'A1.1', u'I', 6, u'DI_FAN6_QF'),
    (u'A1.1', u'I', 7, u'DI_SL6_DKS'),
    (u'A1.1', u'I', 8, u'DI_SL6_QF'),
    (u'A1.1', u'I', 9, u'DI_N7_DKS'),
    (u'A1.1', u'I', 10, u'DI_N7_DSL1'),
    (u'A1.1', u'I', 11, u'DI_N7_DSL2'),
    (u'A1.1', u'I', 12, u'DI_N7_DP'),
    (u'A1.1', u'I', 13, u'DI_N7_SA'),
    (u'A1.1', u'I', 14, u'DI_N7_SB_START'),
    (u'A1.1', u'I', 15, u'DI_N7_SB_STOP'),
    (u'A1.1', u'I', 16, u'DI_N7_SB_ESTOP'),
    (u'A1.1', u'I', 17, u'DI_N7_QF'),
    (u'A1.1', u'I', 18, u'DI_B8_DVU'),
    (u'A1.1', u'I', 19, u'DI_B8_DNU'),
    (u'A1.1', u'I', 20, u'DI_TOR9_QF'),
    (u'A1.1', u'I', 21, u'DI_TOR9FD_SF'),
    (u'A1.1', u'I', 22, u'DI_TOR9FD_FAULT'),
    (u'A1.1', u'I', 23, u'DI_TOR9FD_READY'),
    (u'A1.1', u'I', 24, u'DI_TOR9FD_ESTOP'),
    (u'A1.1', u'I', 25, u'DI_FAN10_QF'),
    (u'A1.1', u'I', 26, u'DI_SL10_DKS'),
    (u'A1.1', u'I', 27, u'DI_SL10_QF'),
    (u'A1.1', u'I', 28, u'DI_N11_DKS'),
    (u'A1.1', u'I', 29, u'DI_N11_DSL1'),
    (u'A1.1', u'I', 30, u'DI_N11_DSL2'),
    (u'A1.1', u'I', 31, u'DI_N11_DP'),
    (u'A1.2', u'I', 0, u'DI_N11_SA'),
    (u'A1.2', u'I', 1, u'DI_N11_SB_START'),
    (u'A1.2', u'I', 2, u'DI_N11_SB_STOP'),
    (u'A1.2', u'I', 3, u'DI_N11_SB_ESTOP'),
    (u'A1.2', u'I', 4, u'DI_N11_QF'),
    (u'A1.2', u'I', 5, u'DI_V121_SF'),
    (u'A1.2', u'I', 6, u'DI_V121_POS1'),
    (u'A1.2', u'I', 7, u'DI_V121_POS2'),
    (u'A1.2', u'I', 8, u'DI_V122_SF'),
    (u'A1.2', u'I', 9, u'DI_V122_POS1'),
    (u'A1.2', u'I', 10, u'DI_V122_POS2'),
    (u'A1.2', u'I', 11, u'DI_V123_SF'),
    (u'A1.2', u'I', 12, u'DI_V123_POS1'),
    (u'A1.2', u'I', 13, u'DI_V123_POS2'),
    (u'A1.2', u'I', 14, u'DI_V124_SF'),
    (u'A1.2', u'I', 15, u'DI_V124_POS1'),
    (u'A1.2', u'I', 16, u'DI_V124_POS2'),
    (u'A1.2', u'I', 17, u'DI_T131_SF'),
    (u'A1.2', u'I', 18, u'DI_T132_SF'),
    (u'A1.2', u'I', 19, u'DI_T131_DVU'),
    (u'A1.2', u'I', 20, u'DI_T131_DNU'),
    (u'A1.2', u'I', 21, u'DI_T132_DVU'),
    (u'A1.2', u'I', 22, u'DI_T132_DNU'),
    (u'A1.2', u'I', 23, u'DI_BT141_SF'),
    (u'A1.2', u'I', 24, u'DI_BT141_FAULT'),
    (u'A1.2', u'I', 25, u'DI_BT141_READY'),
    (u'A1.2', u'I', 26, u'DI_BT14_ESTOP'),
    (u'A1.2', u'I', 27, u'DI_BT142_SF'),
    (u'A1.2', u'I', 28, u'DI_BT142_FAULT'),
    (u'A1.2', u'I', 29, u'DI_BT142_READY'),
    (u'A1.2', u'I', 30, u'DI_N16_DKS'),
    (u'A1.2', u'I', 31, u'DI_N16_DSL1'),
    (u'A1.3', u'I', 0, u'DI_N16_DSL2'),
    (u'A1.3', u'I', 1, u'DI_N16_DP'),
    (u'A1.3', u'I', 2, u'DI_N16_SA'),
    (u'A1.3', u'I', 3, u'DI_N16_SB_START'),
    (u'A1.3', u'I', 4, u'DI_N16_SB_STOP'),
    (u'A1.3', u'I', 5, u'DI_N16_SB_ESTOP'),
    (u'A1.3', u'I', 6, u'DI_N16_QF'),
    (u'A1.3', u'I', 7, u'DI_B17_DVU'),
    (u'A1.3', u'I', 8, u'DI_B17_DNU'),
    (u'A1.3', u'I', 9, u'DI_KSP18_QF'),
    (u'A1.3', u'I', 10, u'DI_KSP18FD_SF'),
    (u'A1.3', u'I', 11, u'DI_KSP18FD_FAULT'),
    (u'A1.3', u'I', 12, u'DI_KSP18FD_READY'),
    (u'A1.3', u'I', 13, u'DI_KSP18FD_ESTOP'),
    (u'A1.3', u'I', 14, u'DI_FAN19_QF'),
    (u'A1.3', u'I', 15, u'DI_SL19_DKS'),
    (u'A1.3', u'I', 16, u'DI_SL19_QF'),
    (u'A1.3', u'I', 17, u'DI_N20_DKS'),
    (u'A1.3', u'I', 18, u'DI_N20_DSL1'),
    (u'A1.3', u'I', 19, u'DI_N20_DSL2'),
    (u'A1.3', u'I', 20, u'DI_N20_DP'),
    (u'A1.3', u'I', 21, u'DI_N20_SA'),
    (u'A1.3', u'I', 22, u'DI_N20_SB_START'),
    (u'A1.3', u'I', 23, u'DI_N20_SB_STOP'),
    (u'A1.3', u'I', 24, u'DI_N20_SB_ESTOP'),
    (u'A1.3', u'I', 25, u'DI_N20_QF'),
    (u'A1.3', u'I', 26, u'DI_N21_DKS'),
    (u'A1.3', u'I', 27, u'DI_N21_DSL1'),
    (u'A1.3', u'I', 28, u'DI_N21_DSL2'),
    (u'A1.3', u'I', 29, u'DI_N21_DP'),
    (u'A1.3', u'I', 30, u'DI_N21_SA'),
    (u'A1.3', u'I', 31, u'DI_N21_SB_START'),
    (u'A1.4', u'I', 0, u'DI_N21_SB_STOP'),
    (u'A1.4', u'I', 1, u'DI_N21_SB_ESTOP'),
    (u'A1.4', u'I', 2, u'DI_N21_QF'),
    (u'A1.4', u'I', 3, u'DI_B22_DVU'),
    (u'A1.4', u'I', 4, u'DI_B22_DNU'),
    (u'A1.4', u'I', 5, u'DI_SP24FAN_QF'),
    (u'A1.4', u'I', 6, u'DI_SP24DRV_SF'),
    (u'A1.4', u'I', 7, u'DI_SP24DRV_FAULT'),
    (u'A1.4', u'I', 8, u'DI_SP24DRV_READY'),
    (u'A1.4', u'I', 9, u'DI_SP24DRV_ESTOP'),
    (u'A1.4', u'I', 10, u'DI_FAN25_QF'),
    (u'A1.4', u'I', 11, u'DI_SL25_DKS'),
    (u'A1.4', u'I', 12, u'DI_SL25_QF'),
    (u'A1.4', u'I', 13, u'DI_FAN28_QF'),
    (u'A1.4', u'I', 14, u'DI_SL28_DKS'),
    (u'A1.4', u'I', 15, u'DI_SL28_QF'),
    (u'A1.4', u'I', 16, u'DI_SH31_DKS'),
    (u'A1.4', u'I', 17, u'DI_SH31_DP'),
    (u'A1.4', u'I', 18, u'DI_SH31_SA'),
    (u'A1.4', u'I', 19, u'DI_SH31_SB_START'),
    (u'A1.4', u'I', 20, u'DI_SH31_SB_STOP'),
    (u'A1.4', u'I', 21, u'DI_SH31_SB_END'),
    (u'A1.4', u'I', 22, u'DI_SH31_QF'),
    (u'A1.4', u'I', 23, u'DI_SH32_DKS'),
    (u'A1.4', u'I', 24, u'DI_SH32_DP'),
    (u'A1.4', u'I', 25, u'DI_SH32_SA'),
    (u'A1.4', u'I', 26, u'DI_SH32_SB_START'),
    (u'A1.4', u'I', 27, u'DI_SH32_SB_STOP'),
    (u'A1.4', u'I', 28, u'DI_SH32_SB_END'),
    (u'A1.4', u'I', 29, u'DI_SH32_QF'),
    (u'A1.4', u'I', 30, u'DI_SH33_DKS'),
    (u'A1.4', u'I', 31, u'DI_SH33_DP'),
    (u'A1.5', u'I', 0, u'DI_SH33_SA'),
    (u'A1.5', u'I', 1, u'DI_SH33_SB_START'),
    (u'A1.5', u'I', 2, u'DI_SH33_SB_STOP'),
    (u'A1.5', u'I', 3, u'DI_SH33_SB_END'),
    (u'A1.5', u'I', 4, u'DI_SH33_QF'),
    (u'A1.5', u'I', 5, u'DI_KC34_DKS'),
    (u'A1.5', u'I', 6, u'DI_KC34_DP'),
    (u'A1.5', u'I', 7, u'DI_KC34_SA'),
    (u'A1.5', u'I', 8, u'DI_KC34_SB_START'),
    (u'A1.5', u'I', 9, u'DI_KC34_SB_STOP'),
    (u'A1.5', u'I', 10, u'DI_KC34_SB_END'),
    (u'A1.5', u'I', 11, u'DI_KC34_QF'),
    (u'A1.5', u'I', 12, u'DI_KC35_DKS'),
    (u'A1.5', u'I', 13, u'DI_KC35_DP'),
    (u'A1.5', u'I', 14, u'DI_KC35_SA'),
    (u'A1.5', u'I', 15, u'DI_KC35_SB_START'),
    (u'A1.5', u'I', 16, u'DI_KC35_SB_STOP'),
    (u'A1.5', u'I', 17, u'DI_KC35_SB_END'),
    (u'A1.5', u'I', 18, u'DI_KC35_QF'),
    (u'A1.5', u'I', 19, u'DI_KC36_DKS'),
    (u'A1.5', u'I', 20, u'DI_KC36_DP'),
    (u'A1.5', u'I', 21, u'DI_KC36_SA'),
    (u'A1.5', u'I', 22, u'DI_KC36_SB_START'),
    (u'A1.5', u'I', 23, u'DI_KC36_SB_STOP'),
    (u'A1.5', u'I', 24, u'DI_KC36_SB_END'),
    (u'A1.5', u'I', 25, u'DI_KC36_QF'),
    (u'A1.5', u'I', 26, u'DI_SH30_DKS'),
    (u'A1.5', u'I', 27, u'DI_SH30_DP'),
    (u'A1.5', u'I', 28, u'DI_SH30_SA'),
    (u'A1.5', u'I', 29, u'DI_SH30_SB_START'),
    (u'A1.5', u'I', 30, u'DI_SH30_SB_STOP'),
    (u'A1.5', u'I', 31, u'DI_SH30_SB_END'),
    (u'A1.6', u'I', 0, u'DI_SH30_QF'),
    (u'A1.6', u'I', 1, u'DI_ZN26_DKS'),
    (u'A1.6', u'I', 2, u'DI_ZN26_RES'),
    (u'A1.6', u'I', 3, u'DI_ZN26_SA'),
    (u'A1.6', u'I', 4, u'DI_ZN26_SB_START'),
    (u'A1.6', u'I', 5, u'DI_ZN26_SB_STOP'),
    (u'A1.6', u'I', 6, u'DI_ZN26_SB_END'),
    (u'A1.6', u'I', 7, u'DI_ZN26_FAULT'),
    (u'A1.6', u'I', 8, u'DI_ZN26_READY'),
    (u'A1.6', u'I', 9, u'DI_ZN26_SF'),
    (u'A1.6', u'I', 10, u'DI_V49_ON'),
    (u'A1.6', u'I', 11, u'DI_V49_OFF'),
    (u'A1.6', u'I', 12, u'DI_ZN29_DKS'),
    (u'A1.6', u'I', 13, u'DI_ZN29_RES'),
    (u'A1.6', u'I', 14, u'DI_ZN29_SA'),
    (u'A1.6', u'I', 15, u'DI_ZN29_SB_START'),
    (u'A1.6', u'I', 16, u'DI_ZN29_SB_STOP'),
    (u'A1.6', u'I', 17, u'DI_ZN29_SB_END'),
    (u'A1.6', u'I', 18, u'DI_ZN29_FAULT'),
    (u'A1.6', u'I', 19, u'DI_ZN29_READY'),
    (u'A1.6', u'I', 20, u'DI_ZN29_SF'),
    (u'A1.6', u'I', 21, u'DI_GATE1_OPENED'),
    (u'A1.6', u'I', 22, u'DI_GATE1_CLOSED'),
    (u'A1.6', u'I', 23, u'DI_GATE1_SA'),
    (u'A1.6', u'I', 24, u'DI_GATE1_SB_OPEN'),
    (u'A1.6', u'I', 25, u'DI_GATE1_SB_CLOSE'),
    (u'A1.6', u'I', 26, u'DI_GATE1_SB_STOP'),
    (u'A1.6', u'I', 27, u'DI_GATE1_FAULT'),
    (u'A1.6', u'I', 28, u'DI_GATE1_READY'),
    (u'A1.6', u'I', 29, u'DI_GATE1_SF'),
    (u'A1.6', u'I', 30, u'DI_B27_DVU1'),
    (u'A1.6', u'I', 31, u'DI_B27_DVU2'),
    (u'A1.7', u'I', 0, u'DI_FS27_ASP_SF'),
    (u'A1.7', u'I', 1, u'DI_FS27_SF'),
    (u'A1.7', u'I', 2, u'DI_FS27_STATUS'),
    (u'A1.7', u'I', 3, u'DI_FS27_REMOTE'),
    (u'A1.7', u'I', 4, u'DI_FS27_ERROR'),
    (u'A1.7', u'I', 5, u'DI_DRYER_SF'),
    (u'A1.7', u'I', 6, u'DI_COMPR_SF'),
    (u'A1.7', u'I', 7, u'DI_COMPR2_SF'),
    (u'A1.7', u'I', 8, u'DI_A17_I8_RES'),
    (u'A1.7', u'I', 9, u'DI_A17_I9_RES'),
    (u'A1', u'Q', 0, u'DO_SIREN'),
    (u'A1', u'Q', 1, u'DO_LAMP_ALARM'),
    (u'A1', u'Q', 2, u'DO_N3_RUN'),
    (u'A1', u'Q', 3, u'DO_MUZ5_RUN'),
    (u'A1', u'Q', 4, u'DO_MUZ5FD_POWER'),
    (u'A1', u'Q', 5, u'DO_MUZ5FD_RESET'),
    (u'A1', u'Q', 6, u'DO_MUZ5FD_RUN'),
    (u'A1', u'Q', 7, u'DO_FAN6_RUN'),
    (u'A1', u'Q', 8, u'DO_SL6_RUN'),
    (u'A1', u'Q', 9, u'DO_N7_RUN'),
    (u'A1', u'Q', 10, u'DO_TOR9_RUN'),
    (u'A1', u'Q', 11, u'DO_TOR9FD_POWER'),
    (u'A1', u'Q', 12, u'DO_TOR9FD_RESET'),
    (u'A1', u'Q', 13, u'DO_TOR9FD_RUN'),
    (u'A1', u'Q', 14, u'DO_FAN10_RUN'),
    (u'A1', u'Q', 15, u'DO_SL10_RUN'),
    (u'A1.8', u'Q', 0, u'DO_N11_RUN'),
    (u'A1.8', u'Q', 1, u'DO_V121_POS1'),
    (u'A1.8', u'Q', 2, u'DO_V121_POS2'),
    (u'A1.8', u'Q', 3, u'DO_V122_POS1'),
    (u'A1.8', u'Q', 4, u'DO_V122_POS2'),
    (u'A1.8', u'Q', 5, u'DO_V123_POS1'),
    (u'A1.8', u'Q', 6, u'DO_V123_POS2'),
    (u'A1.8', u'Q', 7, u'DO_V124_POS1'),
    (u'A1.8', u'Q', 8, u'DO_V124_POS2'),
    (u'A1.8', u'Q', 9, u'DO_A18_Q9_RES'),
    (u'A1.8', u'Q', 10, u'DO_BT141_POWER'),
    (u'A1.8', u'Q', 11, u'DO_BT141_RESET'),
    (u'A1.8', u'Q', 12, u'DO_BT141_RUN'),
    (u'A1.8', u'Q', 13, u'DO_BT142_POWER'),
    (u'A1.8', u'Q', 14, u'DO_BT142_RESET'),
    (u'A1.8', u'Q', 15, u'DO_BT142_RUN'),
    (u'A1.8', u'Q', 16, u'DO_N16_RUN'),
    (u'A1.8', u'Q', 17, u'DO_KSP18_RUN'),
    (u'A1.8', u'Q', 18, u'DO_KSP18FD_POWER'),
    (u'A1.8', u'Q', 19, u'DO_KSP18FD_RESET'),
    (u'A1.8', u'Q', 20, u'DO_KSP18FD_RUN'),
    (u'A1.8', u'Q', 21, u'DO_FAN19_RUN'),
    (u'A1.8', u'Q', 22, u'DO_SL19_RUN'),
    (u'A1.8', u'Q', 23, u'DO_N20_RUN'),
    (u'A1.8', u'Q', 24, u'DO_N21_RUN'),
    (u'A1.8', u'Q', 25, u'DO_SP24FAN_RUN'),
    (u'A1.8', u'Q', 26, u'DO_SP24DRV_POWER'),
    (u'A1.8', u'Q', 27, u'DO_SP24DRV_RESET'),
    (u'A1.8', u'Q', 28, u'DO_SP24DRV_RUN'),
    (u'A1.8', u'Q', 29, u'DO_FAN25_RUN'),
    (u'A1.8', u'Q', 30, u'DO_SL25_RUN'),
    (u'A1.8', u'Q', 31, u'DO_FAN28_RUN'),
    (u'A1.9', u'Q', 0, u'DO_SL28_RUN'),
    (u'A1.9', u'Q', 1, u'DO_SH31_RUN'),
    (u'A1.9', u'Q', 2, u'DO_SH32_RUN'),
    (u'A1.9', u'Q', 3, u'DO_SH33_RUN'),
    (u'A1.9', u'Q', 4, u'DO_KC34_RUN'),
    (u'A1.9', u'Q', 5, u'DO_KC35_RUN'),
    (u'A1.9', u'Q', 6, u'DO_KC36_RUN'),
    (u'A1.9', u'Q', 7, u'DO_SH30_RUN'),
    (u'A1.9', u'Q', 8, u'DO_ZN26_POWER'),
    (u'A1.9', u'Q', 9, u'DO_ZN26_RUN'),
    (u'A1.9', u'Q', 10, u'DO_ZN26_RESET'),
    (u'A1.9', u'Q', 11, u'DO_V49_ON'),
    (u'A1.9', u'Q', 12, u'DO_V49_OFF'),
    (u'A1.9', u'Q', 13, u'DO_ZN29_POWER'),
    (u'A1.9', u'Q', 14, u'DO_ZN29_RUN'),
    (u'A1.9', u'Q', 15, u'DO_ZN29_RESET'),
    (u'A1.9', u'Q', 16, u'DO_GATE1_POWER'),
    (u'A1.9', u'Q', 17, u'DO_GATE1_OPEN'),
    (u'A1.9', u'Q', 18, u'DO_GATE1_RESET'),
    (u'A1.9', u'Q', 19, u'DO_GATE1_CLOSE'),
    (u'A1.9', u'Q', 20, u'DO_FS27_ON'),
    (u'A1.9', u'Q', 21, u'DO_FS27_OFF'),
    (u'A1.9', u'Q', 22, u'DO_FS27_ENABLE'),
    (u'A1.9', u'Q', 23, u'DO_A19_Q23_RES'),
    (u'A1.9', u'Q', 24, u'DO_A19_Q24_RES')
]

# A1 - встроенные DI/DQ контроллера, A1.1..A1.9 - модули под IO_Bus по порядку подключения
EXPECT = {u"A1:I": 24, u"A1:Q": 16}
for _k in range(1, 8):
    EXPECT[u"A1.%d:I" % _k] = 32
for _k in (8, 9):
    EXPECT[u"A1.%d:Q" % _k] = 32


def msg(text, error=False):
    print(text)
    try:
        system.write_message(Severity.Error if error else Severity.Information, text)
    except Exception:
        pass


def children(obj):
    return list(obj.get_children(False))


def find_all(obj, pred, out):
    for c in children(obj):
        if pred(c):
            out.append(c)
        find_all(c, pred, out)
    return out


def leaves(dev):
    """каналы-биты (сопоставляемые элементы без вложенных) в порядке отображения"""
    res = []

    def walk(data):
        if data.has_sub_elements:
            for sub in data:
                walk(sub)
        elif data.is_mappable_io:
            res.append(data)

    sets = [dev.device_parameters]
    try:
        for conn in dev.connectors:
            sets.append(conn.host_parameters)
    except Exception:
        pass
    for ps in sets:
        for p in ps:
            walk(p)
    return res


proj = projects.primary
if proj is None:
    raise Exception(u"Нет открытого проекта")

devs = find_all(proj, lambda o: o.is_device, [])
by_name = {}
for d in devs:
    by_name.setdefault(d.get_name(), []).append(d)

nodes = {}
for key, name in ((u"A1:I", u"DI"), (u"A1:Q", u"DQ")):
    if len(by_name.get(name, [])) == 1:
        nodes[key] = by_name[name][0]
bus = by_name.get(u"IO_Bus", [])
if len(bus) == 1:
    mods = [c for c in children(bus[0]) if c.is_device]
    msg(u"IO_Bus: модулей %d: %s" % (len(mods), u", ".join(m.get_name() for m in mods)))
    for k, m in enumerate(mods, 1):
        nodes[u"A1.%d:%s" % (k, u"I" if k <= 7 else u"Q")] = m
else:
    msg(u"Не найден узел IO_Bus", True)

plan, problems = [], 0
for key in sorted(EXPECT):
    dev = nodes.get(key)
    items = [r for r in MAP if u"%s:%s" % (r[0], r[1]) == key]
    if dev is None:
        msg(u"%s: узел не найден - %d каналов пропущено" % (key, len(items)), True)
        problems += 1
        continue
    lv = leaves(dev)
    msg(u"%s -> %s: каналов в устройстве %d, ожидается %d" % (key, dev.get_name(), len(lv), EXPECT[key]))
    if len(lv) != EXPECT[key]:
        msg(u"  число каналов не совпадает - модуль пропущен, привяжите вручную по IO_map.csv", True)
        problems += 1
        continue
    for mod, kind, ch, var in items:
        data = lv[ch]
        plan.append((data, u"%s.GVL_IO.%s" % (APP, var)))
        msg(u"  %s%d  %-12s -> %s" % (kind, ch, data.identifier, var))

msg(u"Итого к привязке: %d каналов, проблем: %d" % (len(plan), problems), problems > 0)
if APPLY:
    for data, var in plan:
        data.io_mapping.variable = var
    msg(u"Привязка выполнена. Сохраните проект и выполните компиляцию.")
else:
    msg(u"Режим проверки (APPLY = False): изменений не внесено.")
