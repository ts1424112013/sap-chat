* Skill pure-function verification; no database writes and no LLM calls.
REPORT zai_test_skill_core.
DATA: ls_skill TYPE zcl_ai_skill_service=>ty_skill,
      lt_tools TYPE zcl_ai_tool_registry=>tt_tools.

START-OF-SELECTION.
  lt_tools = zcl_ai_tool_registry=>get_tools_for_domain( 'CODE' ).
  ls_skill-id = 'CODE_EXPLAIN'.
  ls_skill-tools = 'read_program_source'.
  zcl_ai_skill_service=>filter_tools( EXPORTING is_skill = ls_skill CHANGING ct_tools = lt_tools ).
  ASSERT lines( lt_tools ) = 1.
  ASSERT lt_tools[ 1 ]-tool_id = 'read_program_source'.
  WRITE: / 'PASS: CODE subset'.

  lt_tools = zcl_ai_tool_registry=>get_tools_for_domain( 'CODE' ).
  ls_skill-tools = 'run_sql'.
  zcl_ai_skill_service=>filter_tools( EXPORTING is_skill = ls_skill CHANGING ct_tools = lt_tools ).
  ASSERT lt_tools IS INITIAL.
  WRITE: / 'PASS: no tool expansion'.

  lt_tools = zcl_ai_tool_registry=>get_tools_for_domain( 'GENERAL' ).
  CLEAR ls_skill-tools.
  zcl_ai_skill_service=>filter_tools( EXPORTING is_skill = ls_skill CHANGING ct_tools = lt_tools ).
  ASSERT lt_tools IS INITIAL.
  WRITE: / 'PASS: result analysis has no tools'.

  lt_tools = zcl_ai_tool_registry=>get_tools_for_domain( 'CODE' ).
  zcl_ai_skill_service=>filter_tools( EXPORTING is_skill = ls_skill CHANGING ct_tools = lt_tools ).
  ASSERT lines( lt_tools ) = 2.
  WRITE: / 'PASS: empty subset preserves scene'.

  ls_skill-name = 'Test skill'.
  ls_skill-version = 3.
  ls_skill-body = 'Read evidence before answering.'.
  DATA(lv_card) = zcl_ai_skill_service=>card( ls_skill ).
  ASSERT lv_card CS 'v3'.
  ASSERT lv_card CS ls_skill-body.
  WRITE: / 'PASS: versioned card', / 'All 5 checks passed'.
