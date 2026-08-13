.include "macros.inc"
.file "ocCfp.cpp"

# 0x80006FA8..0x80006FE8 | size: 0x40
.section extab, "a"
.balign 4

# extab:0x0 | 0x80006FA8 | size: 0x8
.obj "@etb_80006FA8", local
.hidden "@etb_80006FA8"
/*
 * Flag values:
 * Has Elf Vector: No
 * Large Frame: Yes
 * Has Frame Pointer: No
 * Saved CR: No
 */
	.4byte 0x00080000
	.4byte 0x00000000
.endobj "@etb_80006FA8"

# extab:0x8 | 0x80006FB0 | size: 0x8
.obj "@etb_80006FB0", local
.hidden "@etb_80006FB0"
/*
 * Flag values:
 * Has Elf Vector: No
 * Large Frame: Yes
 * Has Frame Pointer: No
 * Saved CR: No
 * Saved GPR range: r31
 */
	.4byte 0x08080000
	.4byte 0x00000000
.endobj "@etb_80006FB0"

# extab:0x10 | 0x80006FB8 | size: 0x8
.obj "@etb_80006FB8", local
.hidden "@etb_80006FB8"
/*
 * Flag values:
 * Has Elf Vector: No
 * Large Frame: Yes
 * Has Frame Pointer: No
 * Saved CR: No
 * Saved GPR range: r31
 */
	.4byte 0x08080000
	.4byte 0x00000000
.endobj "@etb_80006FB8"

# extab:0x18 | 0x80006FC0 | size: 0x8
.obj "@etb_80006FC0", local
.hidden "@etb_80006FC0"
/*
 * Flag values:
 * Has Elf Vector: No
 * Large Frame: Yes
 * Has Frame Pointer: No
 * Saved CR: No
 * Saved GPR range: r31
 */
	.4byte 0x08080000
	.4byte 0x00000000
.endobj "@etb_80006FC0"

# extab:0x20 | 0x80006FC8 | size: 0x8
.obj "@etb_80006FC8", local
.hidden "@etb_80006FC8"
/*
 * Flag values:
 * Has Elf Vector: No
 * Large Frame: Yes
 * Has Frame Pointer: No
 * Saved CR: No
 */
	.4byte 0x00080000
	.4byte 0x00000000
.endobj "@etb_80006FC8"

# extab:0x28 | 0x80006FD0 | size: 0x8
.obj "@etb_80006FD0", local
.hidden "@etb_80006FD0"
/*
 * Flag values:
 * Has Elf Vector: No
 * Large Frame: Yes
 * Has Frame Pointer: No
 * Saved CR: No
 */
	.4byte 0x00080000
	.4byte 0x00000000
.endobj "@etb_80006FD0"

# extab:0x30 | 0x80006FD8 | size: 0x8
.obj "@etb_80006FD8", local
.hidden "@etb_80006FD8"
/*
 * Flag values:
 * Has Elf Vector: No
 * Large Frame: Yes
 * Has Frame Pointer: No
 * Saved CR: No
 * Saved GPR range: r31
 */
	.4byte 0x08080000
	.4byte 0x00000000
.endobj "@etb_80006FD8"

# extab:0x38 | 0x80006FE0 | size: 0x8
.obj "@etb_80006FE0", local
.hidden "@etb_80006FE0"
/*
 * Flag values:
 * Has Elf Vector: No
 * Large Frame: Yes
 * Has Frame Pointer: No
 * Saved CR: No
 * Saved GPR range: r31
 */
	.4byte 0x08080000
	.4byte 0x00000000
.endobj "@etb_80006FE0"

# 0x80021D90..0x80021DF0 | size: 0x60
.section extabindex, "a"
.balign 4

# extabindex:0x0 | 0x80021D90 | size: 0xC
.obj "@eti_80021D90", local
.hidden "@eti_80021D90"
	.4byte func_80045560
	.4byte 0x0000003C
	.4byte "@etb_80006FA8"
.endobj "@eti_80021D90"

# extabindex:0xC | 0x80021D9C | size: 0xC
.obj "@eti_80021D9C", local
.hidden "@eti_80021D9C"
	.4byte func_8004559C
	.4byte 0x0000004C
	.4byte "@etb_80006FB0"
.endobj "@eti_80021D9C"

# extabindex:0x18 | 0x80021DA8 | size: 0xC
.obj "@eti_80021DA8", local
.hidden "@eti_80021DA8"
	.4byte func_800455E8
	.4byte 0x0000004C
	.4byte "@etb_80006FB8"
.endobj "@eti_80021DA8"

# extabindex:0x24 | 0x80021DB4 | size: 0xC
.obj "@eti_80021DB4", local
.hidden "@eti_80021DB4"
	.4byte func_80045634
	.4byte 0x00000060
	.4byte "@etb_80006FC0"
.endobj "@eti_80021DB4"

# extabindex:0x30 | 0x80021DC0 | size: 0xC
.obj "@eti_80021DC0", local
.hidden "@eti_80021DC0"
	.4byte func_80045694
	.4byte 0x00000030
	.4byte "@etb_80006FC8"
.endobj "@eti_80021DC0"

# extabindex:0x3C | 0x80021DCC | size: 0xC
.obj "@eti_80021DCC", local
.hidden "@eti_80021DCC"
	.4byte func_800456C4
	.4byte 0x00000030
	.4byte "@etb_80006FD0"
.endobj "@eti_80021DCC"

# extabindex:0x48 | 0x80021DD8 | size: 0xC
.obj "@eti_80021DD8", local
.hidden "@eti_80021DD8"
	.4byte getTimeIdxMin
	.4byte 0x00000088
	.4byte "@etb_80006FD8"
.endobj "@eti_80021DD8"

# extabindex:0x54 | 0x80021DE4 | size: 0xC
.obj "@eti_80021DE4", local
.hidden "@eti_80021DE4"
	.4byte getTimeIdxMax
	.4byte 0x0000008C
	.4byte "@etb_80006FE0"
.endobj "@eti_80021DE4"

# 0x80045B00..0x80045DB4 | size: 0x2B4
.text
.balign 4

# .text:0x0 | 0x80045B00 | size: 0x3C
.fn func_80045560, global
/* 80045B00 0000ED40  94 21 FF F0 */	stwu r1, -0x10(r1)
/* 80045B04 0000ED44  7C 08 02 A6 */	mflr r0
/* 80045B08 0000ED48  38 80 00 09 */	li r4, 0x9
/* 80045B0C 0000ED4C  90 01 00 14 */	stw r0, 0x14(r1)
/* 80045B10 0000ED50  38 00 00 00 */	li r0, 0x0
/* 80045B14 0000ED54  98 81 00 08 */	stb r4, 0x8(r1)
/* 80045B18 0000ED58  38 81 00 08 */	addi r4, r1, 0x8
/* 80045B1C 0000ED5C  B0 A1 00 0A */	sth r5, 0xa(r1)
/* 80045B20 0000ED60  90 01 00 0C */	stw r0, 0xc(r1)
/* 80045B24 0000ED64  48 45 F5 D5 */	bl vmRetValSet
/* 80045B28 0000ED68  80 01 00 14 */	lwz r0, 0x14(r1)
/* 80045B2C 0000ED6C  38 60 00 01 */	li r3, 0x1
/* 80045B30 0000ED70  7C 08 03 A6 */	mtlr r0
/* 80045B34 0000ED74  38 21 00 10 */	addi r1, r1, 0x10
/* 80045B38 0000ED78  4E 80 00 20 */	blr
.endfn func_80045560

# .text:0x3C | 0x80045B3C | size: 0x4C
.fn func_8004559C, global
/* 80045B3C 0000ED7C  94 21 FF E0 */	stwu r1, -0x20(r1)
/* 80045B40 0000ED80  7C 08 02 A6 */	mflr r0
/* 80045B44 0000ED84  90 01 00 24 */	stw r0, 0x24(r1)
/* 80045B48 0000ED88  38 00 00 03 */	li r0, 0x3
/* 80045B4C 0000ED8C  93 E1 00 1C */	stw r31, 0x1c(r1)
/* 80045B50 0000ED90  7C 7F 1B 78 */	mr r31, r3
/* 80045B54 0000ED94  98 01 00 08 */	stb r0, 0x8(r1)
/* 80045B58 0000ED98  48 04 1C 21 */	bl func_80086DA0__Q22cf13CfGameManagerFv
/* 80045B5C 0000ED9C  54 60 04 3E */	clrlwi r0, r3, 16
/* 80045B60 0000EDA0  90 01 00 0C */	stw r0, 0xc(r1)
/* 80045B64 0000EDA4  7F E3 FB 78 */	mr r3, r31
/* 80045B68 0000EDA8  38 81 00 08 */	addi r4, r1, 0x8
/* 80045B6C 0000EDAC  48 45 F5 8D */	bl vmRetValSet
/* 80045B70 0000EDB0  83 E1 00 1C */	lwz r31, 0x1c(r1)
/* 80045B74 0000EDB4  38 60 00 01 */	li r3, 0x1
/* 80045B78 0000EDB8  80 01 00 24 */	lwz r0, 0x24(r1)
/* 80045B7C 0000EDBC  7C 08 03 A6 */	mtlr r0
/* 80045B80 0000EDC0  38 21 00 20 */	addi r1, r1, 0x20
/* 80045B84 0000EDC4  4E 80 00 20 */	blr
.endfn func_8004559C

# .text:0x88 | 0x80045B88 | size: 0x4C
.fn func_800455E8, global
/* 80045B88 0000EDC8  94 21 FF E0 */	stwu r1, -0x20(r1)
/* 80045B8C 0000EDCC  7C 08 02 A6 */	mflr r0
/* 80045B90 0000EDD0  90 01 00 24 */	stw r0, 0x24(r1)
/* 80045B94 0000EDD4  38 00 00 03 */	li r0, 0x3
/* 80045B98 0000EDD8  93 E1 00 1C */	stw r31, 0x1c(r1)
/* 80045B9C 0000EDDC  7C 7F 1B 78 */	mr r31, r3
/* 80045BA0 0000EDE0  98 01 00 08 */	stb r0, 0x8(r1)
/* 80045BA4 0000EDE4  48 04 1B D9 */	bl func_80086DA4__Q22cf13CfGameManagerFv
/* 80045BA8 0000EDE8  54 60 04 3E */	clrlwi r0, r3, 16
/* 80045BAC 0000EDEC  90 01 00 0C */	stw r0, 0xc(r1)
/* 80045BB0 0000EDF0  7F E3 FB 78 */	mr r3, r31
/* 80045BB4 0000EDF4  38 81 00 08 */	addi r4, r1, 0x8
/* 80045BB8 0000EDF8  48 45 F5 41 */	bl vmRetValSet
/* 80045BBC 0000EDFC  83 E1 00 1C */	lwz r31, 0x1c(r1)
/* 80045BC0 0000EE00  38 60 00 01 */	li r3, 0x1
/* 80045BC4 0000EE04  80 01 00 24 */	lwz r0, 0x24(r1)
/* 80045BC8 0000EE08  7C 08 03 A6 */	mtlr r0
/* 80045BCC 0000EE0C  38 21 00 20 */	addi r1, r1, 0x20
/* 80045BD0 0000EE10  4E 80 00 20 */	blr
.endfn func_800455E8

# .text:0xD4 | 0x80045BD4 | size: 0x60
.fn func_80045634, global
/* 80045BD4 0000EE14  94 21 FF E0 */	stwu r1, -0x20(r1)
/* 80045BD8 0000EE18  7C 08 02 A6 */	mflr r0
/* 80045BDC 0000EE1C  90 01 00 24 */	stw r0, 0x24(r1)
/* 80045BE0 0000EE20  38 00 00 03 */	li r0, 0x3
/* 80045BE4 0000EE24  93 E1 00 1C */	stw r31, 0x1c(r1)
/* 80045BE8 0000EE28  7C 7F 1B 78 */	mr r31, r3
/* 80045BEC 0000EE2C  98 01 00 08 */	stb r0, 0x8(r1)
/* 80045BF0 0000EE30  48 04 1B 89 */	bl func_80086DA0__Q22cf13CfGameManagerFv
/* 80045BF4 0000EE34  3C 80 55 55 */	lis r4, 0x5555
/* 80045BF8 0000EE38  54 60 04 3E */	clrlwi r0, r3, 16
/* 80045BFC 0000EE3C  38 84 55 56 */	addi r4, r4, 0x5556
/* 80045C00 0000EE40  7F E3 FB 78 */	mr r3, r31
/* 80045C04 0000EE44  7C A4 00 96 */	mulhw r5, r4, r0
/* 80045C08 0000EE48  38 81 00 08 */	addi r4, r1, 0x8
/* 80045C0C 0000EE4C  54 A0 0F FE */	srwi r0, r5, 31
/* 80045C10 0000EE50  7C 05 02 14 */	add r0, r5, r0
/* 80045C14 0000EE54  90 01 00 0C */	stw r0, 0xc(r1)
/* 80045C18 0000EE58  48 45 F4 E1 */	bl vmRetValSet
/* 80045C1C 0000EE5C  83 E1 00 1C */	lwz r31, 0x1c(r1)
/* 80045C20 0000EE60  38 60 00 01 */	li r3, 0x1
/* 80045C24 0000EE64  80 01 00 24 */	lwz r0, 0x24(r1)
/* 80045C28 0000EE68  7C 08 03 A6 */	mtlr r0
/* 80045C2C 0000EE6C  38 21 00 20 */	addi r1, r1, 0x20
/* 80045C30 0000EE70  4E 80 00 20 */	blr
.endfn func_80045634

# .text:0x134 | 0x80045C34 | size: 0x30
.fn func_80045694, global
/* 80045C34 0000EE74  94 21 FF F0 */	stwu r1, -0x10(r1)
/* 80045C38 0000EE78  7C 08 02 A6 */	mflr r0
/* 80045C3C 0000EE7C  90 01 00 14 */	stw r0, 0x14(r1)
/* 80045C40 0000EE80  48 45 F7 11 */	bl vmOCPropertyGet
/* 80045C44 0000EE84  80 03 00 04 */	lwz r0, 0x4(r3)
/* 80045C48 0000EE88  54 03 04 3E */	clrlwi r3, r0, 16
/* 80045C4C 0000EE8C  48 04 1B 1D */	bl func_80086D90__Q22cf13CfGameManagerFv
/* 80045C50 0000EE90  80 01 00 14 */	lwz r0, 0x14(r1)
/* 80045C54 0000EE94  38 60 00 00 */	li r3, 0x0
/* 80045C58 0000EE98  7C 08 03 A6 */	mtlr r0
/* 80045C5C 0000EE9C  38 21 00 10 */	addi r1, r1, 0x10
/* 80045C60 0000EEA0  4E 80 00 20 */	blr
.endfn func_80045694

# .text:0x164 | 0x80045C64 | size: 0x30
.fn func_800456C4, global
/* 80045C64 0000EEA4  94 21 FF F0 */	stwu r1, -0x10(r1)
/* 80045C68 0000EEA8  7C 08 02 A6 */	mflr r0
/* 80045C6C 0000EEAC  90 01 00 14 */	stw r0, 0x14(r1)
/* 80045C70 0000EEB0  48 45 F6 E1 */	bl vmOCPropertyGet
/* 80045C74 0000EEB4  80 03 00 04 */	lwz r0, 0x4(r3)
/* 80045C78 0000EEB8  54 03 04 3E */	clrlwi r3, r0, 16
/* 80045C7C 0000EEBC  48 04 1A F1 */	bl func_80086D94__Q22cf13CfGameManagerFv
/* 80045C80 0000EEC0  80 01 00 14 */	lwz r0, 0x14(r1)
/* 80045C84 0000EEC4  38 60 00 00 */	li r3, 0x0
/* 80045C88 0000EEC8  7C 08 03 A6 */	mtlr r0
/* 80045C8C 0000EECC  38 21 00 10 */	addi r1, r1, 0x10
/* 80045C90 0000EED0  4E 80 00 20 */	blr
.endfn func_800456C4

# .text:0x194 | 0x80045C94 | size: 0x88
.fn getTimeIdxMin, global
/* 80045C94 0000EED4  94 21 FF E0 */	stwu r1, -0x20(r1)
/* 80045C98 0000EED8  7C 08 02 A6 */	mflr r0
/* 80045C9C 0000EEDC  38 80 00 01 */	li r4, 0x1
/* 80045CA0 0000EEE0  90 01 00 24 */	stw r0, 0x24(r1)
/* 80045CA4 0000EEE4  93 E1 00 1C */	stw r31, 0x1c(r1)
/* 80045CA8 0000EEE8  7C 7F 1B 78 */	mr r31, r3
/* 80045CAC 0000EEEC  48 45 F1 29 */	bl vmArgPtrGet
/* 80045CB0 0000EEF0  7C 64 1B 78 */	mr r4, r3
/* 80045CB4 0000EEF4  38 60 00 02 */	li r3, 0x2
/* 80045CB8 0000EEF8  48 45 F2 71 */	bl vmArgIntGet
/* 80045CBC 0000EEFC  2C 03 00 07 */	cmpwi r3, 0x7
/* 80045CC0 0000EF00  40 81 00 24 */	ble .L_80045CE4
/* 80045CC4 0000EF04  38 60 00 03 */	li r3, 0x3
/* 80045CC8 0000EF08  38 00 00 00 */	li r0, 0x0
/* 80045CCC 0000EF0C  98 61 00 08 */	stb r3, 0x8(r1)
/* 80045CD0 0000EF10  7F E3 FB 78 */	mr r3, r31
/* 80045CD4 0000EF14  90 01 00 0C */	stw r0, 0xc(r1)
/* 80045CD8 0000EF18  48 45 F6 39 */	bl vmOCExceptionThrow
/* 80045CDC 0000EF1C  38 60 00 00 */	li r3, 0x0
/* 80045CE0 0000EF20  48 00 00 28 */	b .L_80045D08
.L_80045CE4:
/* 80045CE4 0000EF24  54 60 10 3A */	slwi r0, r3, 2
/* 80045CE8 0000EF28  38 80 00 03 */	li r4, 0x3
/* 80045CEC 0000EF2C  7C 03 00 50 */	subf r0, r3, r0
/* 80045CF0 0000EF30  98 81 00 08 */	stb r4, 0x8(r1)
/* 80045CF4 0000EF34  7F E3 FB 78 */	mr r3, r31
/* 80045CF8 0000EF38  38 81 00 08 */	addi r4, r1, 0x8
/* 80045CFC 0000EF3C  90 01 00 0C */	stw r0, 0xc(r1)
/* 80045D00 0000EF40  48 45 F3 F9 */	bl vmRetValSet
/* 80045D04 0000EF44  38 60 00 01 */	li r3, 0x1
.L_80045D08:
/* 80045D08 0000EF48  80 01 00 24 */	lwz r0, 0x24(r1)
/* 80045D0C 0000EF4C  83 E1 00 1C */	lwz r31, 0x1c(r1)
/* 80045D10 0000EF50  7C 08 03 A6 */	mtlr r0
/* 80045D14 0000EF54  38 21 00 20 */	addi r1, r1, 0x20
/* 80045D18 0000EF58  4E 80 00 20 */	blr
.endfn getTimeIdxMin

# .text:0x21C | 0x80045D1C | size: 0x8C
.fn getTimeIdxMax, global
/* 80045D1C 0000EF5C  94 21 FF E0 */	stwu r1, -0x20(r1)
/* 80045D20 0000EF60  7C 08 02 A6 */	mflr r0
/* 80045D24 0000EF64  38 80 00 01 */	li r4, 0x1
/* 80045D28 0000EF68  90 01 00 24 */	stw r0, 0x24(r1)
/* 80045D2C 0000EF6C  93 E1 00 1C */	stw r31, 0x1c(r1)
/* 80045D30 0000EF70  7C 7F 1B 78 */	mr r31, r3
/* 80045D34 0000EF74  48 45 F0 A1 */	bl vmArgPtrGet
/* 80045D38 0000EF78  7C 64 1B 78 */	mr r4, r3
/* 80045D3C 0000EF7C  38 60 00 02 */	li r3, 0x2
/* 80045D40 0000EF80  48 45 F1 E9 */	bl vmArgIntGet
/* 80045D44 0000EF84  2C 03 00 07 */	cmpwi r3, 0x7
/* 80045D48 0000EF88  40 81 00 24 */	ble .L_80045D6C
/* 80045D4C 0000EF8C  38 60 00 03 */	li r3, 0x3
/* 80045D50 0000EF90  38 00 00 00 */	li r0, 0x0
/* 80045D54 0000EF94  98 61 00 08 */	stb r3, 0x8(r1)
/* 80045D58 0000EF98  7F E3 FB 78 */	mr r3, r31
/* 80045D5C 0000EF9C  90 01 00 0C */	stw r0, 0xc(r1)
/* 80045D60 0000EFA0  48 45 F5 B1 */	bl vmOCExceptionThrow
/* 80045D64 0000EFA4  38 60 00 00 */	li r3, 0x0
/* 80045D68 0000EFA8  48 00 00 2C */	b .L_80045D94
.L_80045D6C:
/* 80045D6C 0000EFAC  38 83 00 01 */	addi r4, r3, 0x1
/* 80045D70 0000EFB0  38 00 00 03 */	li r0, 0x3
/* 80045D74 0000EFB4  54 83 10 3A */	slwi r3, r4, 2
/* 80045D78 0000EFB8  98 01 00 08 */	stb r0, 0x8(r1)
/* 80045D7C 0000EFBC  7C 04 18 50 */	subf r0, r4, r3
/* 80045D80 0000EFC0  38 81 00 08 */	addi r4, r1, 0x8
/* 80045D84 0000EFC4  90 01 00 0C */	stw r0, 0xc(r1)
/* 80045D88 0000EFC8  7F E3 FB 78 */	mr r3, r31
/* 80045D8C 0000EFCC  48 45 F3 6D */	bl vmRetValSet
/* 80045D90 0000EFD0  38 60 00 01 */	li r3, 0x1
.L_80045D94:
/* 80045D94 0000EFD4  80 01 00 24 */	lwz r0, 0x24(r1)
/* 80045D98 0000EFD8  83 E1 00 1C */	lwz r31, 0x1c(r1)
/* 80045D9C 0000EFDC  7C 08 03 A6 */	mtlr r0
/* 80045DA0 0000EFE0  38 21 00 20 */	addi r1, r1, 0x20
/* 80045DA4 0000EFE4  4E 80 00 20 */	blr
.endfn getTimeIdxMax

# .text:0x2A8 | 0x80045DA8 | size: 0xC
.fn ocCfpRegist, global
/* 80045DA8 0000EFE8  3C 60 80 52 */	lis r3, lbl_eu_80525D58@ha
/* 80045DAC 0000EFEC  38 63 5D 58 */	addi r3, r3, lbl_eu_80525D58@l
/* 80045DB0 0000EFF0  48 45 F4 28 */	b vmOCRegist
.endfn ocCfpRegist
.fn func_80086D90__Q22cf13CfGameManagerFv, global
/* 80087768 000509A8  4B FE 33 DC */	b func_8006A12C
.endfn func_80086D90__Q22cf13CfGameManagerFv
.fn func_80086D94__Q22cf13CfGameManagerFv, global
/* 8008776C 000509AC  4B FE 34 4C */	b func_8006A1A0
.endfn func_80086D94__Q22cf13CfGameManagerFv
