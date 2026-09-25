(* Главная программа. Вызывается из задачи MAST (циклическая, 20 мс). *)
PROGRAM PLC_PRG

PRG_Inputs();
PRG_System();
PRG_Topology();
PRG_Routes();
PRG_Mechs();
PRG_Outputs();
END_PROGRAM
