*=======================================================================
* 对象:   ZCL_AI_ABAP_CHECK
* 用途:   新引擎工具 abap_check —— 对模型写出的 ABAP 程序源码做语法检查(11.10 记录 #13:
*         生成的程序粘贴进 SAP 才发现激活报错, 表名 / 字段 / 语法都没查过)
*         ① 只检查, 不保存、不生成、不激活: SYNTAX-CHECK FOR itab ... DIRECTORY ENTRY,
*            程序名用占位名 ZLINGXI_SYNTAX_CHECK(SAP 里不需要存在), 按可执行程序、Unicode 检查
*         ② 代码里用到的表 / 结构 / 数据元素在本系统不存在时同样报错(顺带做了「表存在」检查)
*         ③ 一条语句一次只报第一个错误(ABAP SYNTAX-CHECK 本身的限制): 模型改了再查, 直到通过
*         ④ 只查完整的程序(REPORT / PROGRAM 开头; 没写时自动在最前面补一行, 行号照旧按原文);
*            全局类 / 函数模块 / include 片段查不了 —— 回 ok:false 说明, 让模型在回答里写明未检查
* 工具参数: {"source":"<完整源码>","name":"<程序名, 只用于回显>"}
* 配置:   ZAI_CHAT_CFG-BROWSER_ABAP_CHECK = N 时不下发(默认开, 只给开放了代码分析的用户)
* 依赖:   无(只用 SYNTAX-CHECK 语句与 TRDIR 结构)
* 安装:   SE24 -> 创建类 -> 源代码粘帖 (ABAP 7.50 语法, 755 适用); 再贴 ZCL_AI_AGENT_SERVICE V15.31
* V1.0    20261110: 首版
* ★ 重贴后核对标记: 有 METHOD check / tool_desc / tool_params; check 里有 SYNTAX-CHECK FOR lt_src 与
*   DIRECTORY ENTRY ls_dir; 本类没有 INSERT REPORT / GENERATE / INSERT / UPDATE / DELETE(只查不存)
*=======================================================================
CLASS zcl_ai_abap_check DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    CONSTANTS gc_tool TYPE string VALUE 'abap_check'.
    " 源码上限(字符): 超过的程序请拆开查
    CONSTANTS gc_max_chars TYPE i VALUE 300000.

    " 检查一段源码, 返回给模型的 JSON:
    "   通过  {"ok":true,"passed":true,"lines":N,"message":"…"}
    "   有错  {"ok":true,"passed":false,"line":L,"word":"…","message":"…","code":"<那一行>","note":"…"}
    "   查不了 {"ok":false,"error":"…"}
    CLASS-METHODS check
      IMPORTING iv_source      TYPE string
                iv_name        TYPE string OPTIONAL
      RETURNING VALUE(rv_json) TYPE string.

    CLASS-METHODS tool_desc
      RETURNING VALUE(rv) TYPE string.

    CLASS-METHODS tool_params
      RETURNING VALUE(rv) TYPE string.

  PROTECTED SECTION.
  PRIVATE SECTION.

    CLASS-METHODS jtext
      IMPORTING iv        TYPE string
      RETURNING VALUE(rv) TYPE string.

ENDCLASS.



CLASS zcl_ai_abap_check IMPLEMENTATION.


  METHOD tool_desc.
    rv = `对你写好或改好的 ABAP 程序做语法检查(和 SE38 里点检查一样, 只查不保存, SAP 里不需要已经有这个程序)。` &&
         `用到的表、结构、字段在本系统不存在时也会报错。一次只报第一个错误: 按报错行号改了再查, 直到 passed = true。` &&
         `只能查完整程序(REPORT 开头); 全局类、函数模块、include 片段查不了。` &&
         `源码在文件夹里时传 file_path(引擎读文件), 否则把完整源码放在 source 里。`.
  ENDMETHOD.


  METHOD tool_params.
    rv = `{"type":"object","properties":{` &&
         `"source":{"type":"string","description":"完整的程序源码(从 REPORT 那一行开始)"},` &&
         `"file_path":{"type":"string","description":"源码在用户文件夹里时给文件路径, 如 /程序/zidpmm501.abap(和 source 二选一)"},` &&
         `"name":{"type":"string","description":"程序名, 只用于回显"}}}`.
  ENDMETHOD.


  METHOD check.

    DATA: lt_src  TYPE string_table,
          lv_msg  TYPE string,
          lv_line TYPE i,
          lv_word TYPE string,
          lv_rc   TYPE i,
          ls_dir  TYPE trdir.

    DATA(lv_src) = iv_source.
    IF lv_src IS INITIAL.
      rv_json = `{"ok":false,"error":"source 为空: 把完整源码放在 source 里(或在文件夹里时传 file_path)"}`.
      RETURN.
    ENDIF.
    IF strlen( lv_src ) > gc_max_chars.
      rv_json = |\{"ok":false,"error":"源码太长({ strlen( lv_src ) } 字符, 上限 { gc_max_chars }), 请拆开检查"\}|.
      RETURN.
    ENDIF.

    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>cr_lf IN lv_src WITH cl_abap_char_utilities=>newline.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>horizontal_tab IN lv_src WITH `  `.
    SPLIT lv_src AT cl_abap_char_utilities=>newline INTO TABLE lt_src.

    " ---- 第一条语句: 判断是不是完整程序 ----
    DATA lv_first TYPE string.
    LOOP AT lt_src INTO DATA(lv_l).
      DATA(lv_t) = condense( lv_l ).
      IF lv_t IS INITIAL OR lv_t(1) = '*' OR lv_t(1) = '"'.
        CONTINUE.
      ENDIF.
      lv_first = to_upper( lv_t ).
      EXIT.
    ENDLOOP.
    IF lv_first IS INITIAL.
      rv_json = `{"ok":false,"error":"源码里只有注释或空行"}`.
      RETURN.
    ENDIF.
    IF lv_first CP 'CLASS *DEFINITION*PUBLIC*' OR lv_first CP 'INTERFACE *PUBLIC*'.
      rv_json = `{"ok":false,"error":"这是全局类 / 接口, abap_check 只能查完整程序; 请在回答里说明这段代码没有经过语法检查(对象已在 SAP 里时可用 adt_syntax_check)"}`.
      RETURN.
    ENDIF.
    IF lv_first CP 'FUNCTION *' OR lv_first CP 'FUNCTION-POOL*'.
      rv_json = `{"ok":false,"error":"这是函数模块 / 函数组, abap_check 只能查完整程序; 请在回答里说明这段代码没有经过语法检查"}`.
      RETURN.
    ENDIF.
    " 没有 REPORT / PROGRAM 开头(代码片段): 在最前面补一行再查, 报错行号减回去
    DATA(lv_shift) = 0.
    IF NOT ( lv_first CP 'REPORT*' OR lv_first CP 'PROGRAM*' ).
      INSERT `REPORT zlingxi_syntax_check.` INTO lt_src INDEX 1.
      lv_shift = 1.
    ENDIF.

    ls_dir-name    = 'ZLINGXI_SYNTAX_CHECK'.
    ls_dir-subc    = '1'.
    ls_dir-fixpt   = abap_true.
    ls_dir-uccheck = abap_true.

    TRY.
        SYNTAX-CHECK FOR lt_src MESSAGE lv_msg LINE lv_line WORD lv_word DIRECTORY ENTRY ls_dir.
        lv_rc = sy-subrc.
      CATCH cx_root INTO DATA(lx_err).
        rv_json = |\{"ok":false,"error":"语法检查没能执行: { jtext( lx_err->get_text( ) ) }"\}|.
        RETURN.
    ENDTRY.

    DATA(lv_lines) = lines( lt_src ) - lv_shift.
    IF lv_rc = 0.
      rv_json = |\{"ok":true,"passed":true,"lines":{ lv_lines },| &&
                |"message":"语法检查通过(只说明能激活; 业务逻辑、取数口径对不对还要另外核对)"\}|.
      RETURN.
    ENDIF.
    IF lv_rc <> 4.
      rv_json = |\{"ok":false,"error":"语法检查没能完成(返回码 { lv_rc }): { jtext( lv_msg ) }"\}|.
      RETURN.
    ENDIF.

    " ---- 有语法错误: 行号按原文, 带上那一行代码 ----
    DATA(lv_at) = lv_line - lv_shift.
    DATA lv_code TYPE string.
    IF lv_line > 0 AND lv_line <= lines( lt_src ).
      lv_code = condense( lt_src[ lv_line ] ).
      IF strlen( lv_code ) > 200.
        lv_code = lv_code(200).
      ENDIF.
    ENDIF.
    IF lv_at < 1.
      lv_at = 1.
    ENDIF.
    rv_json = |\{"ok":true,"passed":false,"line":{ lv_at },"word":"{ jtext( lv_word ) }",| &&
              |"message":"{ jtext( lv_msg ) }","code":"{ jtext( lv_code ) }",| &&
              |"note":"一次只报第一个错误: 改好这一处(同类写法一起改)后再查一次, 直到 passed = true 再交给用户"\}|.

  ENDMETHOD.


  METHOD jtext.
    rv = iv.
    REPLACE ALL OCCURRENCES OF `\` IN rv WITH `\\`.
    REPLACE ALL OCCURRENCES OF `"` IN rv WITH `\"`.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>cr_lf IN rv WITH `\n`.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>newline IN rv WITH `\n`.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>horizontal_tab IN rv WITH ` `.
  ENDMETHOD.

ENDCLASS.
