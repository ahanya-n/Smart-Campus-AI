import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:speech_to_text/speech_to_text.dart';
import 'package:flutter_tts/flutter_tts.dart';

import '../app_scope.dart';
import '../models/app_user.dart';
import '../models/timetable.dart';
import '../services/api_service.dart';
import '../services/auth_controller.dart';
import 'mood_screen.dart';

class AssistantPickedDocument {
  const AssistantPickedDocument({
    required this.name,
    required this.size,
    required this.path,
    this.bytes,
  });

  final String name;
  final int size;
  final String? path;
  final Uint8List? bytes;
}

class _StudyQuizDialog extends StatefulWidget {
  const _StudyQuizDialog({required this.title, required this.questions});

  final String title;
  final List<Map<String, dynamic>> questions;

  @override
  State<_StudyQuizDialog> createState() => _StudyQuizDialogState();
}

class _StudyQuizDialogState extends State<_StudyQuizDialog> {
  final TextEditingController _answerController = TextEditingController();
  int _index = 0;
  bool _checked = false;
  bool _correct = false;

  @override
  void dispose() {
    _answerController.dispose();
    super.dispose();
  }

  void _next() {
    setState(() {
      _index++;
      _checked = false;
      _correct = false;
      _answerController.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    final hasQuestions = widget.questions.isNotEmpty;
    final question = hasQuestions
        ? widget.questions[_index]
        : const <String, dynamic>{};
    final answer = question['answer']?.toString().trim() ?? '';
    return AlertDialog(
      title: Text(widget.title),
      content: SizedBox(
        width: 440,
        child: !hasQuestions
            ? const Text('No quiz questions could be generated.')
            : SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Question ${_index + 1} of ${widget.questions.length}',
                    ),
                    const SizedBox(height: 12),
                    Text(question['question']?.toString() ?? ''),
                    const SizedBox(height: 12),
                    TextField(
                      key: const Key('study_quiz_answer'),
                      controller: _answerController,
                      enabled: !_checked,
                      decoration: const InputDecoration(
                        labelText: 'Your answer',
                        border: OutlineInputBorder(),
                      ),
                      onChanged: (_) => setState(() {}),
                      minLines: 1,
                      maxLines: 3,
                    ),
                    if (_checked) ...[
                      const SizedBox(height: 12),
                      Text(
                        _correct
                            ? 'Correct.'
                            : 'Not quite. Suggested answer: $answer',
                      ),
                    ],
                  ],
                ),
              ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Close'),
        ),
        if (hasQuestions)
          FilledButton(
            onPressed: _checked
                ? (_index + 1 < widget.questions.length ? _next : null)
                : _answerController.text.trim().isEmpty
                ? null
                : () {
                    setState(() {
                      _checked = true;
                      _correct =
                          _answerController.text.trim().toLowerCase() ==
                          answer.toLowerCase();
                    });
                  },
            child: Text(
              _checked
                  ? (_index + 1 < widget.questions.length
                        ? 'Next question'
                        : 'Finished')
                  : 'Check answer',
            ),
          ),
      ],
    );
  }
}

class _StudyFlashcardsDialog extends StatefulWidget {
  const _StudyFlashcardsDialog({required this.title, required this.cards});

  final String title;
  final List<Map<String, dynamic>> cards;

  @override
  State<_StudyFlashcardsDialog> createState() => _StudyFlashcardsDialogState();
}

class _StudyFlashcardsDialogState extends State<_StudyFlashcardsDialog> {
  int _index = 0;
  bool _showBack = false;

  @override
  Widget build(BuildContext context) {
    final hasCards = widget.cards.isNotEmpty;
    final card = hasCards ? widget.cards[_index] : const <String, dynamic>{};
    return AlertDialog(
      title: Text(widget.title),
      content: SizedBox(
        width: 420,
        child: hasCards
            ? InkWell(
                key: const Key('study_flashcard'),
                onTap: () => setState(() => _showBack = !_showBack),
                child: Card(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          'Card ${_index + 1} of ${widget.cards.length} · '
                          '${_showBack ? 'Answer' : 'Prompt'}',
                        ),
                        const SizedBox(height: 16),
                        Text(
                          (card[_showBack ? 'back' : 'front'] ?? '').toString(),
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: 16),
                        const Text('Tap the card to flip it.'),
                      ],
                    ),
                  ),
                ),
              )
            : const Text('No flashcards could be generated.'),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Close'),
        ),
        if (hasCards)
          TextButton(
            onPressed: _index == 0
                ? null
                : () => setState(() {
                    _index--;
                    _showBack = false;
                  }),
            child: const Text('Previous'),
          ),
        if (hasCards)
          FilledButton(
            onPressed: _index + 1 >= widget.cards.length
                ? null
                : () => setState(() {
                    _index++;
                    _showBack = false;
                  }),
            child: const Text('Next'),
          ),
      ],
    );
  }
}

class _ChatMessage {
  _ChatMessage({
    required this.text,
    required this.isUser,
    required this.time,
    this.intent,
    this.provider,
    this.action,
    this.suggestions = const [],
    this.sources = const [],
    this.requiresConfirmation = false,
    this.confirmationId,
    this.retryQuery,
  });

  final String text;
  final bool isUser;
  final DateTime time;
  final String? intent;
  final String? provider;
  final Map<String, dynamic>? action;
  final List<String> suggestions;
  final List<String> sources;
  final bool requiresConfirmation;
  final String? confirmationId;
  final String? retryQuery;
}

class CampusAssistantScreen extends StatefulWidget {
  const CampusAssistantScreen({super.key, this.initialQuery, this.filePicker});

  final String? initialQuery;
  final Future<AssistantPickedDocument?> Function()? filePicker;

  @override
  State<CampusAssistantScreen> createState() => _CampusAssistantScreenState();
}

class _CampusAssistantScreenState extends State<CampusAssistantScreen> {
  static const _allowedDocumentExtensions = {'pdf', 'docx', 'txt'};
  static const _maxDocumentBytes = 5 * 1024 * 1024;

  final TextEditingController _controller = TextEditingController();
  final TextEditingController _careerGoalController = TextEditingController();
  final TextEditingController _companyController = TextEditingController();
  final TextEditingController _targetRoleController = TextEditingController();
  final TextEditingController _salaryController = TextEditingController();
  final TextEditingController _currentSkillsController =
      TextEditingController();
  final TextEditingController _skillsToImproveController =
      TextEditingController();
  final TextEditingController _preparationLevelController =
      TextEditingController();
  final TextEditingController _applicationTimelineController =
      TextEditingController();
  final TextEditingController _jobDescriptionController =
      TextEditingController();
  final TextEditingController _moodReflectionController =
      TextEditingController();
  final ScrollController _scrollController = ScrollController();
  final SpeechToText _speech = SpeechToText();
  final FlutterTts _tts = FlutterTts();

  late AuthController _auth;
  String? _authIdentity;
  final List<_ChatMessage> _messages = [];
  bool _loading = false;
  bool _listening = false;
  String _selectedMode = 'general';
  String? _conversationId;
  String? _conversationError;
  List<Map<String, dynamic>> _conversations = [];
  final Map<String, String> _conversationModes = {};
  List<Map<String, dynamic>> _studyDocuments = [];
  String? _studyDocumentId;
  bool _studyDocumentsLoading = false;
  bool _studyUploadLoading = false;
  String? _studyDocumentsError;
  String? _studyUploadError;
  String? _quizLoadingId;
  String? _flashcardsLoadingId;
  String _selectedMood = 'neutral';
  bool _moodCheckInLoading = false;
  bool _moodCheckInSubmitting = false;
  String? _moodCheckInError;
  String? _moodCheckInMessage;
  List<Map<String, dynamic>> _moodCheckIns = [];
  bool _placementResearchLoading = false;
  int _placementResearchRequestId = 0;
  bool _allowExternalProcessing = false;
  bool _placementUploadLoading = false;
  bool _placementAnalysisLoading = false;
  String? _placementResearchError;
  String? _placementUploadError;
  String? _placementUploadMessage;
  Map<String, dynamic>? _placementResearchResult;
  Map<String, dynamic>? _placementDocument;
  Map<String, dynamic>? _placementAnalysis;
  String? _placementAnalysisError;
  String _selectedDay = defaultTimetableDay(DateTime.now());

  static const List<String> _suggestedQuestions = [
    'What is my attendance percentage?',
    'Which subjects have low attendance?',
    'Which subjects need improvement?',
    'Create a 7-day study plan.',
    'Explain my academic risk report.',
    'Analyze my internal marks.',
    'What should I focus on before exams?',
    'What is my timetable for today?',
    'When is my next class?',
    'When am I free today?',
    'How much free time do I have between classes?',
  ];

  List<String> _suggestionsForMode() {
    for (final message in _messages.reversed) {
      if (!message.isUser && message.suggestions.isNotEmpty) {
        return message.suggestions;
      }
    }
    return switch (_selectedMode) {
      'placement' => const [
        'Create a placement preparation plan.',
        'What skills should I build for this role?',
        'Give me a technical interview practice question.',
      ],
      'study' => const [
        'Explain this topic at my current level.',
        'Create a 7-day study plan.',
        'Quiz me on the material I uploaded.',
      ],
      'mood' => const [
        'How does a private mood check-in work?',
        'Can I skip the optional reflection?',
      ],
      _ =>
        _auth.user?.isStudent == true
            ? _suggestedQuestions
            : const [
                'What is my next class?',
                'Where is my next classroom?',
                'What is my timetable today?',
                'Which students need academic attention?',
              ],
    };
  }

  @override
  void initState() {
    super.initState();
    _auth = AppScope.read(context).auth;
    _authIdentity = _identityFor(_auth.user);
    _auth.addListener(_handleAuthChange);
    _messages.add(
      _ChatMessage(
        text: 'Hello! I am your AI Campus Assistant. Ask me anything about your attendance, daily schedule, upcoming classes, or free time windows.',
        isUser: false,
        time: DateTime.now(),
        provider: 'grounded_rule_engine',
      ),
    );
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadConversations());

    if (widget.initialQuery != null && widget.initialQuery!.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _sendMessage(widget.initialQuery!);
      });
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final auth = AppScope.of(context).auth;
    if (auth != _auth) {
      _auth.removeListener(_handleAuthChange);
      _auth = auth;
      _authIdentity = _identityFor(_auth.user);
      _auth.addListener(_handleAuthChange);
      _resetAccountState();
      WidgetsBinding.instance.addPostFrameCallback((_) => _loadConversations());
    }
  }

  @override
  void dispose() {
    _auth.removeListener(_handleAuthChange);
    _speech.stop();
    _tts.stop();
    _controller.dispose();
    _careerGoalController.dispose();
    _companyController.dispose();
    _targetRoleController.dispose();
    _salaryController.dispose();
    _currentSkillsController.dispose();
    _skillsToImproveController.dispose();
    _preparationLevelController.dispose();
    _applicationTimelineController.dispose();
    _jobDescriptionController.dispose();
    _moodReflectionController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  void _handleAuthChange() {
    if (!mounted) return;
    final identity = _identityFor(_auth.user);
    if (identity == _authIdentity) return;
    _authIdentity = identity;
    setState(_resetAccountState);
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadConversations());
  }

  String? _identityFor(AppUser? user) =>
      user == null ? null : '${user.email}\u0000${user.role}';

  void _resetAccountState() {
    _selectedMode = 'general';
    _conversationId = null;
    _conversationError = null;
    _loading = false;
    _conversationModes.clear();
    _conversations = [];
    _studyDocuments = [];
    _studyDocumentId = null;
    _studyDocumentsLoading = false;
    _studyUploadLoading = false;
    _studyDocumentsError = null;
    _studyUploadError = null;
    _quizLoadingId = null;
    _flashcardsLoadingId = null;
    _selectedMood = 'neutral';
    _moodCheckInLoading = false;
    _moodCheckInSubmitting = false;
    _moodCheckInError = null;
    _moodCheckInMessage = null;
    _moodCheckIns = [];
    _placementResearchLoading = false;
    _placementResearchRequestId++;
    _placementUploadLoading = false;
    _placementAnalysisLoading = false;
    _placementResearchResult = null;
    _placementDocument = null;
    _placementAnalysis = null;
    _placementAnalysisError = null;
    _placementResearchError = null;
    _allowExternalProcessing = false;
    _jobDescriptionController.clear();
    _companyController.clear();
    _targetRoleController.clear();
    _salaryController.clear();
    _currentSkillsController.clear();
    _skillsToImproveController.clear();
    _preparationLevelController.clear();
    _applicationTimelineController.clear();
    _moodReflectionController.clear();
    _placementUploadError = null;
    _placementUploadMessage = null;
    _careerGoalController.clear();
    _messages
      ..clear()
      ..add(
        _ChatMessage(
          text: 'Hello! I am your AI Campus Assistant. Ask me anything about your campus records, daily schedule, upcoming classes, or free time windows.',
          isUser: false,
          time: DateTime.now(),
          provider: 'grounded_rule_engine',
        ),
      );
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }
    });
  }

  Future<bool> _sendMessage(
    String text, {
    Map<String, dynamic>? placementContext,
  }) async {
    final query = text.trim();
    if (query.isEmpty || _loading) return false;
    final isStudent = _auth.user?.isStudent == true;
    final mode = isStudent ? _selectedMode : 'general';
    final requestIdentity = _authIdentity;

    _controller.clear();
    setState(() {
      _messages.add(
        _ChatMessage(text: query, isUser: true, time: DateTime.now()),
      );
      _loading = true;
    });
    _scrollToBottom();

    final api = AppScope.read(context).api;
    try {
      final historyStart = (_messages.length - 8)
          .clamp(0, _messages.length)
          .toInt();
      final history = _messages.sublist(historyStart).map((message) {
        return <String, dynamic>{
          'role': message.isUser ? 'user' : 'assistant',
          'content': message.text,
          if (!message.isUser && message.intent != null)
            'intent': message.intent,
        };
      }).toList();
      String? documentId;
      if (_selectedMode == 'study') {
        documentId = _studyDocumentId;
      } else if (_selectedMode == 'placement') {
        documentId = _placementDocument?['id']?.toString();
      }
      final res = await api.askAssistant(
        query,
        mode: mode,
        day: _selectedDay,
        history: history,
        conversationId: _conversationId,
        documentId: documentId,
        placementContext: mode == 'placement'
            ? placementContext ?? _placementContext()
            : null,
      );
      if (!mounted || requestIdentity != _authIdentity) return false;
      final responseMode = res['mode']?.toString();
      if (responseMode != null && responseMode != mode) {
        throw const ApiException(
          'The assistant returned a response for a different mode.',
        );
      }
      final responseText = res['reply'];
      if (responseText is! String || responseText.trim().isEmpty) {
        throw const ApiException(
          'The assistant response did not contain a reply.',
        );
      }
      final returnedConversationId = res['conversation_id']?.toString();
      if (returnedConversationId != null && returnedConversationId.isNotEmpty) {
        _conversationId = returnedConversationId;
        _conversationModes[returnedConversationId] = _normalizeConversationMode(
          res['mode']?.toString() ?? _selectedMode,
        );
        WidgetsBinding.instance.addPostFrameCallback(
          (_) => _loadConversations(),
        );
      }
      var reply = responseText.trim();
      final studyPlan = res['study_plan'];
      if (studyPlan is List && studyPlan.isNotEmpty) {
        reply +=
            '\n\nStudy plan:\n${studyPlan.whereType<Map>().map((item) => '${item['day']}: ${item['subject']}${item['time_window'] == null ? '' : ' · ${item['time_window']}'} — ${item['activity']}').join('\n')}';
      }
      final recommendations = res['recommendations'];
      if (recommendations is List && recommendations.isNotEmpty) {
        reply += '\n\nRecommendations:\n${recommendations.join('\n')}';
      }
      final limitations = res['data_limitations'];
      if (limitations is List && limitations.isNotEmpty) {
        reply += '\n\nMissing information: ${limitations.join(' ')}';
      }
      if (res['disclaimer'] != null) {
        reply += '\n\n${res['disclaimer']}';
      }
      if (mounted) {
        setState(() {
          _messages.add(
            _ChatMessage(
              text: reply,
              isUser: false,
              time: DateTime.now(),
              intent: res['intent']?.toString(),
              provider: res['provider']?.toString(),
              suggestions: _stringValues(res['suggestions']),
              sources: _stringValues(res['sources']),
              action: res['action'] is Map
                  ? Map<String, dynamic>.from(res['action'] as Map)
                  : null,
              requiresConfirmation: res['requires_confirmation'] == true,
              confirmationId: res['confirmation_id']?.toString(),
            ),
          );
        });
        _scrollToBottom();
      }
      return true;
    } on ApiException catch (e) {
      if (mounted && requestIdentity == _authIdentity) {
        setState(() {
          _messages.add(
            _ChatMessage(
              text: '⚠️ ${e.message}',
              isUser: false,
              time: DateTime.now(),
              retryQuery: query,
            ),
          );
        });
        _scrollToBottom();
      }
      return false;
    } finally {
      if (mounted && requestIdentity == _authIdentity) {
        setState(() => _loading = false);
      }
    }
  }

  List<String> _stringValues(dynamic value) =>
      value is List ? value.whereType<String>().toList() : const [];

  List<Map<String, dynamic>> _mapValues(dynamic value) => value is List
      ? value.whereType<Map>().map((item) {
          return item.map((key, value) => MapEntry(key.toString(), value));
        }).toList()
      : const [];

  Future<void> _startVoiceInput() async {
    final available = await _speech.initialize(
      onError: (_) {
        if (mounted) setState(() => _listening = false);
      },
      onStatus: (status) {
        if (status == 'done' || status == 'notListening') {
          if (mounted) setState(() => _listening = false);
        }
      },
    );
    if (!available) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Voice input is unavailable or microphone permission was denied.',
          ),
        ),
      );
      return;
    }
    setState(() => _listening = true);
    await _speech.listen(
      onResult: (result) {
        setState(() => _controller.text = result.recognizedWords);
      },
      listenOptions: SpeechListenOptions(localeId: 'en_IN'),
    );
  }

  Future<void> _stopVoiceInput() async {
    await _speech.stop();
    if (mounted) setState(() => _listening = false);
  }

  Future<void> _speakLatestResponse() async {
    _ChatMessage? latest;
    for (final message in _messages.reversed) {
      if (!message.isUser) {
        latest = message;
        break;
      }
    }
    if (latest != null) {
      await _tts.stop();
      await _tts.speak(latest.text);
    }
  }

  Future<void> _loadConversations() async {
    final identity = _authIdentity;
    final api = AppScope.read(context).api;
    if (mounted && identity == _authIdentity) {
      setState(() => _conversationError = null);
    }
    try {
      final items = await api.listAssistantConversations(mode: _selectedMode);
      if (!mounted || identity != _authIdentity) return;
      setState(() {
        _conversationError = null;
        _conversations = items
            .where(
              (conversation) =>
                  _modeForConversation(conversation) == _selectedMode,
            )
            .toList();
      });
    } on ApiException catch (error) {
      if (!mounted || identity != _authIdentity) return;
      setState(() => _conversationError = error.message);
    }
  }

  String _modeForConversation(Map<String, dynamic> conversation) {
    final id = conversation['id']?.toString() ?? '';
    final mode = conversation['mode']?.toString() ?? _conversationModes[id];
    return _normalizeConversationMode(mode ?? 'general');
  }

  String _normalizeConversationMode(String mode) => switch (mode) {
    'study_buddy' => 'study',
    'general' || 'placement' || 'study' || 'mood' => mode,
    _ => 'general',
  };

  Future<void> _loadConversation(String id) async {
    final identity = _authIdentity;
    final summary = _conversations.where((item) => item['id'] == id);
    final metadata = summary.isEmpty ? null : summary.first;
    if (_modeForConversation(metadata ?? {'id': id}) != _selectedMode) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('That conversation belongs to another assistant mode.'),
        ),
      );
      return;
    }
    final api = AppScope.read(context).api;
    try {
      final conversation = await api.getAssistantConversation(id);
      if (!mounted || identity != _authIdentity) return;
      final detailMode = _normalizeConversationMode(
        conversation['mode']?.toString() ??
            _conversationModes[id] ??
            metadata?['mode']?.toString() ??
            'general',
      );
      if (detailMode != _selectedMode) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'That conversation belongs to another assistant mode.',
            ),
          ),
        );
        return;
      }
      final messages = (conversation['messages'] as List?) ?? const [];
      setState(() {
        _conversationId = id;
        _messages
          ..clear()
          ..addAll(
            messages.whereType<Map>().map(
              (item) => _ChatMessage(
                text: item['content']?.toString() ?? '',
                isUser: item['role'] == 'user',
                time: DateTime.now(),
                intent: item['intent']?.toString(),
                provider: item['provider']?.toString(),
              ),
            ),
          );
      });
    } on ApiException catch (error) {
      if (!mounted || identity != _authIdentity) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  Future<void> _newConversation() async {
    final identity = _authIdentity;
    final api = AppScope.read(context).api;
    try {
      final conversation = await api.createAssistantConversation(
        mode: _selectedMode,
      );
      if (!mounted || identity != _authIdentity) return;
      final id = conversation['id']?.toString();
      if (id != null && id.isNotEmpty) {
        _conversationModes[id] = _normalizeConversationMode(
          conversation['mode']?.toString() ?? _selectedMode,
        );
      }
      setState(() {
        _conversationId = id;
        _messages
          ..clear()
          ..add(
            _ChatMessage(
              text: 'New conversation started. Ask about your campus records or placement preparation.',
              isUser: false,
              time: DateTime.now(),
            ),
          );
      });
      _loadConversations();
    } on ApiException catch (error) {
      if (!mounted || identity != _authIdentity) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  Future<void> _clearConversation() async {
    final identity = _authIdentity;
    final conversationId = _conversationId;
    final api = AppScope.read(context).api;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Clear conversation'),
        content: const Text('Delete this saved conversation?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true || identity != _authIdentity) return;
    if (conversationId != null) {
      try {
        await api.deleteAssistantConversation(conversationId);
        if (!mounted || identity != _authIdentity) return;
      } on ApiException catch (error) {
        if (!mounted || identity != _authIdentity) return;
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.message)));
        return;
      }
    }
    await _newConversation();
  }

  Future<void> _confirmAction(String confirmationId) async {
    final api = AppScope.read(context).api;
    try {
      final result = await api.confirmAssistantAction(confirmationId);
      if (!mounted) return;
      setState(() {
        _messages.add(
          _ChatMessage(
            text: result['success'] == true
                ? 'Action completed successfully.'
                : 'The action could not be confirmed.',
            isUser: false,
            time: DateTime.now(),
          ),
        );
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  void _retryMessage(_ChatMessage failedMessage) {
    final query = failedMessage.retryQuery;
    if (query == null || _loading) return;
    final failedIndex = _messages.indexOf(failedMessage);
    if (failedIndex >= 0) {
      setState(() {
        _messages.removeAt(failedIndex);
        final previousIndex = failedIndex - 1;
        if (previousIndex >= 0 &&
            _messages[previousIndex].isUser &&
            _messages[previousIndex].text == query) {
          _messages.removeAt(previousIndex);
        }
      });
    }
    _sendMessage(query);
  }

  Future<void> _startPlacementPractice() async {
    String topic = 'Java';
    String difficulty = 'beginner';
    final selected = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Placement practice'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              DropdownButtonFormField<String>(
                initialValue: topic,
                items:
                    const [
                          'Java',
                          'Python',
                          'SQL',
                          'DBMS',
                          'OOP',
                          'Operating Systems',
                          'Computer Networks',
                          'DSA',
                          'Aptitude',
                          'HR Interview',
                          'Technical Interview',
                        ]
                        .map(
                          (value) => DropdownMenuItem(
                            value: value,
                            child: Text(value),
                          ),
                        )
                        .toList(),
                onChanged: (value) =>
                    setDialogState(() => topic = value ?? 'Java'),
              ),
              DropdownButtonFormField<String>(
                initialValue: difficulty,
                items: const ['beginner', 'intermediate', 'advanced']
                    .map(
                      (value) =>
                          DropdownMenuItem(value: value, child: Text(value)),
                    )
                    .toList(),
                onChanged: (value) =>
                    setDialogState(() => difficulty = value ?? 'beginner'),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('Cancel'),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('Start'),
            ),
          ],
        ),
      ),
    );
    if (selected != true) return;
    if (!mounted) return;
    final api = AppScope.read(context).api;
    try {
      final session = await api.createPlacementPractice(
        topic: topic,
        difficulty: difficulty,
      );
      if (!mounted) return;
      String answerController = '';
      final answer = await showDialog<String>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: Text(session['topic']?.toString() ?? topic),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(session['question']?.toString() ?? ''),
              const SizedBox(height: 12),
              TextField(
                maxLines: 5,
                maxLength: 5000,
                decoration: const InputDecoration(labelText: 'Your answer'),
                onChanged: (value) => answerController = value,
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(null),
              child: const Text('Cancel'),
            ),
            TextButton(
              onPressed: () =>
                  Navigator.of(dialogContext).pop(answerController),
              child: const Text('Evaluate'),
            ),
          ],
        ),
      );
      if (answer == null || answer.trim().isEmpty) return;
      final result = await api.evaluatePlacementPractice(
        session['id']?.toString() ?? '',
        answer,
      );
      if (!mounted) return;
      setState(() {
        _messages.add(
          _ChatMessage(
            text:
                'Placement evaluation (${result['score']}%): ${result['evaluation']}',
            isUser: false,
            time: DateTime.now(),
            intent: 'placement_preparation',
            provider: result['provider']?.toString(),
          ),
        );
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  Future<void> _prepareComplaint() async {
    String category = 'facilities';
    String title = '';
    String description = '';
    final prepared = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Prepare complaint'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                DropdownButtonFormField<String>(
                  initialValue: category,
                  items:
                      const [
                            'academic',
                            'facilities',
                            'transport',
                            'library',
                            'safety',
                            'other',
                          ]
                          .map(
                            (value) => DropdownMenuItem(
                              value: value,
                              child: Text(value),
                            ),
                          )
                          .toList(),
                  onChanged: (value) {
                    setDialogState(() => category = value ?? 'other');
                  },
                ),
                TextField(
                  decoration: const InputDecoration(labelText: 'Title'),
                  maxLength: 120,
                  onChanged: (value) => title = value,
                ),
                TextField(
                  decoration: const InputDecoration(labelText: 'Description'),
                  maxLines: 4,
                  maxLength: 5000,
                  onChanged: (value) => description = value,
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('Cancel'),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('Review'),
            ),
          ],
        ),
      ),
    );
    if (prepared != true ||
        title.trim().length < 3 ||
        description.trim().length < 10) {
      return;
    }
    if (!mounted) return;
    final api = AppScope.read(context).api;
    try {
      final result = await api.prepareComplaintAction(
        category: category,
        title: title.trim(),
        description: description.trim(),
      );
      final confirmationId = result['confirmation_id']?.toString();
      if (!mounted || confirmationId == null) return;
      setState(() {
        _messages.add(
          _ChatMessage(
            text:
                'Review complaint:\n${category.toUpperCase()} — ${title.trim()}\n${description.trim()}',
            isUser: false,
            time: DateTime.now(),
            intent: 'create_complaint',
            requiresConfirmation: true,
            confirmationId: confirmationId,
          ),
        );
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  Future<void> _cancelAction(String confirmationId) async {
    final api = AppScope.read(context).api;
    try {
      await api.cancelAssistantAction(confirmationId);
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Action cancelled.')));
    } on ApiException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  void _selectMode(String mode) {
    if (_selectedMode == mode ||
        _loading ||
        (mode != 'general' && _auth.user?.isStudent != true)) {
      return;
    }
    setState(() {
      _selectedMode = mode;
      _conversationId = null;
      _conversationError = null;
      _conversations = [];
      _allowExternalProcessing = false;
      _jobDescriptionController.clear();
      _placementResearchLoading = false;
      _placementResearchRequestId++;
      _placementResearchResult = null;
      _placementResearchError = null;
      _messages
        ..clear()
        ..add(
          _ChatMessage(
            text: switch (mode) {
              'placement' => 'Placement Assistant selected.',
              'study' => 'Study Buddy selected.',
              'mood' => 'Mood Detector selected. Use a private check-in for saved wellbeing records.',
              _ => 'General Campus Assistant selected.',
            },
            isUser: false,
            time: DateTime.now(),
          ),
        );
    });
    if (mode == 'study') {
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => _loadStudyDocuments(),
      );
    } else if (mode == 'placement') {
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => _loadPlacementDocuments(),
      );
    } else if (mode == 'mood') {
      WidgetsBinding.instance.addPostFrameCallback((_) => _loadMoodCheckIns());
    }
    _loadConversations();
  }

  Future<void> _loadStudyDocuments() async {
    if (!mounted || _auth.user?.isStudent != true) return;
    final identity = _authIdentity;
    setState(() {
      _studyDocumentsLoading = true;
      _studyDocumentsError = null;
    });
    try {
      final documents = await AppScope.read(context).api.getStudyDocuments();
      if (mounted && identity == _authIdentity) {
        setState(() {
          _studyDocuments = documents;
          final currentId = _studyDocumentId;
          _studyDocumentId =
              documents.any((item) => item['id']?.toString() == currentId)
              ? currentId
              : documents.isEmpty
              ? null
              : documents.first['id']?.toString();
        });
      }
    } on ApiException catch (error) {
      if (mounted && identity == _authIdentity) {
        setState(() => _studyDocumentsError = error.message);
      }
    } finally {
      if (mounted && identity == _authIdentity) {
        setState(() => _studyDocumentsLoading = false);
      }
    }
  }

  Future<void> _loadMoodCheckIns() async {
    if (!mounted || _auth.user?.isStudent != true) return;
    final identity = _authIdentity;
    setState(() {
      _moodCheckInLoading = true;
      _moodCheckInError = null;
    });
    try {
      final checkIns = await AppScope.read(context).api.getMyMoodCheckIns();
      if (mounted && identity == _authIdentity && _selectedMode == 'mood') {
        setState(() => _moodCheckIns = checkIns);
      }
    } on ApiException catch (error) {
      if (mounted && identity == _authIdentity) {
        setState(() => _moodCheckInError = error.message);
      }
    } finally {
      if (mounted && identity == _authIdentity) {
        setState(() => _moodCheckInLoading = false);
      }
    }
  }

  Future<void> _submitMoodCheckIn() async {
    if (_auth.user?.isStudent != true || _moodCheckInSubmitting) return;
    final identity = _authIdentity;
    final api = AppScope.read(context).api;
    setState(() {
      _moodCheckInSubmitting = true;
      _moodCheckInError = null;
      _moodCheckInMessage = null;
    });
    try {
      final result = await api.createMoodCheckIn(
        _selectedMood,
        reflection: _moodReflectionController.text,
      );
      final checkIns = await api.getMyMoodCheckIns();
      if (!mounted || identity != _authIdentity) return;
      setState(() {
        _moodCheckIns = checkIns;
        _moodCheckInMessage =
            result['support_message']?.toString() ??
            'Your private check-in was saved.';
        _moodReflectionController.clear();
      });
    } on ApiException catch (error) {
      if (mounted && identity == _authIdentity) {
        setState(() => _moodCheckInError = error.message);
      }
    } finally {
      if (mounted && identity == _authIdentity) {
        setState(() => _moodCheckInSubmitting = false);
      }
    }
  }

  Future<void> _loadPlacementDocuments() async {
    if (!mounted || _auth.user?.isStudent != true) return;
    final identity = _authIdentity;
    try {
      final documents = await AppScope.read(context).api
          .getPlacementDocuments();
      if (mounted &&
          identity == _authIdentity &&
          _selectedMode == 'placement') {
        setState(() {
          _placementDocument = documents.isEmpty ? null : documents.first;
        });
      }
    } on ApiException catch (error) {
      if (mounted &&
          identity == _authIdentity &&
          _selectedMode == 'placement') {
        setState(() => _placementUploadError = error.message);
      }
    }
  }

  Future<void> _analyzeStudyDocument(Map<String, dynamic> document) async {
    final id = document['id']?.toString();
    if (id == null || id.isEmpty) return;
    try {
      final result = await AppScope.read(context).api.analyzeStudyDocument(id);
      if (!mounted) return;
      final info = result['document'] is Map
          ? Map<String, dynamic>.from(result['document'] as Map)
          : <String, dynamic>{};
      final chapterAnalysis = result['chapter_topic_analysis'] is Map
          ? Map<String, dynamic>.from(result['chapter_topic_analysis'] as Map)
          : const <String, dynamic>{};
      final importantMaterial = result['important_material'] is Map
          ? Map<String, dynamic>.from(result['important_material'] as Map)
          : const <String, dynamic>{};
      final sampleQuestions = result['sample_exam_questions'] is Map
          ? Map<String, dynamic>.from(result['sample_exam_questions'] as Map)
          : const <String, dynamic>{};
      await showDialog<void>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: Text('Analysis: ${document['filename'] ?? 'Study document'}'),
          content: SizedBox(
            width: 440,
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Main subject: ${info['main_subject'] ?? 'Insufficient information'}',
                  ),
                  const SizedBox(height: 8),
                  Text(info['summary']?.toString() ?? ''),
                  const SizedBox(height: 12),
                  const Text('Main topics and chapters'),
                  ..._stringValues(chapterAnalysis['main_topics'])
                      .map((topic) => Text('• $topic')),
                  if (_mapValues(chapterAnalysis['chapters_detected'])
                      .isNotEmpty) ...[
                    const SizedBox(height: 8),
                    const Text('Detected chapters'),
                    ..._mapValues(chapterAnalysis['chapters_detected']).map(
                      (chapter) => Text(
                        '• ${chapter['title'] ?? chapter['name'] ?? chapter}',
                      ),
                    ),
                  ],
                  if (_stringValues(chapterAnalysis['important_subtopics'])
                      .isNotEmpty) ...[
                    const SizedBox(height: 8),
                    const Text('Important subtopics'),
                    ..._stringValues(chapterAnalysis['important_subtopics'])
                        .map((topic) => Text('• $topic')),
                  ],
                  if (_mapValues(chapterAnalysis['important_definitions'])
                      .isNotEmpty) ...[
                    const SizedBox(height: 8),
                    const Text('Important definitions'),
                    ..._mapValues(chapterAnalysis['important_definitions']).map(
                      (definition) => Text(
                        '• ${definition['front'] ?? ''}\n'
                        '${definition['back'] ?? ''}',
                      ),
                    ),
                  ],
                  const SizedBox(height: 12),
                  const Text('Important points'),
                  ..._stringValues(importantMaterial['important_points'])
                      .map((point) => Text('• $point')),
                  if (_stringValues(importantMaterial['formulas'])
                      .isNotEmpty) ...[
                    const SizedBox(height: 8),
                    const Text('Formulas'),
                    ..._stringValues(importantMaterial['formulas'])
                        .map((formula) => Text('• $formula')),
                  ],
                  if (_stringValues(importantMaterial['examples'])
                      .isNotEmpty) ...[
                    const SizedBox(height: 8),
                    const Text('Examples'),
                    ..._stringValues(importantMaterial['examples'])
                        .map((example) => Text('• $example')),
                  ],
                  if (_stringValues(
                    importantMaterial['topics_for_more_attention'],
                  ).isNotEmpty) ...[
                    const SizedBox(height: 8),
                    const Text('Topics for more attention'),
                    ..._stringValues(
                      importantMaterial['topics_for_more_attention'],
                    ).map((topic) => Text('• $topic')),
                  ],
                  const SizedBox(height: 12),
                  const Text('Sample exam questions'),
                  ..._mapValues(sampleQuestions['questions']).map(
                    (item) => Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(
                        '${item['marks'] ?? ''}-mark: ${item['question'] ?? ''}\n'
                        'Answer: ${item['answer'] ?? 'Not provided'}',
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  const Text('MCQs'),
                  ..._mapValues(sampleQuestions['mcqs']).map(
                    (item) => Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(
                        '${item['question'] ?? ''}\n'
                        'Options: ${_stringValues(item['options']).join(' | ')}\n'
                        'Answer: ${item['answer'] ?? 'Not provided'}\n'
                        '${item['explanation'] ?? ''}',
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('Close'),
            ),
          ],
        ),
      );
    } on ApiException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  Future<void> _generateStudyQuiz(Map<String, dynamic> document) async {
    if (_auth.user?.isStudent != true) return;
    final identity = _authIdentity;
    final id = document['id']?.toString();
    if (id == null || id.isEmpty) return;
    setState(() => _quizLoadingId = id);
    try {
      final result = await AppScope.read(context).api.createStudyQuiz(id);
      if (!mounted || identity != _authIdentity) return;
      setState(() => _quizLoadingId = null);
      final questions = _mapValues(result['questions']);
      await showDialog<void>(
        context: context,
        builder: (_) => _StudyQuizDialog(
          title: 'Quiz: ${document['filename'] ?? 'Study material'}',
          questions: questions,
        ),
      );
    } on ApiException catch (error) {
      if (mounted && identity == _authIdentity) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.message)));
      }
    } finally {
      if (mounted && identity == _authIdentity) {
        setState(() => _quizLoadingId = null);
      }
    }
  }

  Future<void> _generateStudyFlashcards(Map<String, dynamic> document) async {
    if (_auth.user?.isStudent != true) return;
    final identity = _authIdentity;
    final id = document['id']?.toString();
    if (id == null || id.isEmpty) return;
    setState(() => _flashcardsLoadingId = id);
    try {
      final result = await AppScope.read(context).api.createStudyFlashcards(id);
      if (!mounted || identity != _authIdentity) return;
      setState(() => _flashcardsLoadingId = null);
      await showDialog<void>(
        context: context,
        builder: (_) => _StudyFlashcardsDialog(
          title: 'Flashcards: ${document['filename'] ?? 'Study material'}',
          cards: _mapValues(result['flashcards']),
        ),
      );
    } on ApiException catch (error) {
      if (mounted && identity == _authIdentity) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.message)));
      }
    } finally {
      if (mounted && identity == _authIdentity) {
        setState(() => _flashcardsLoadingId = null);
      }
    }
  }

  Map<String, dynamic> _placementContext() {
    final context = <String, dynamic>{};
    void add(String key, TextEditingController controller) {
      final value = controller.text.trim();
      if (value.isNotEmpty) context[key] = value;
    }

    add('company', _companyController);
    add('role', _targetRoleController);
    add('salary', _salaryController);
    add('current_skills', _currentSkillsController);
    add('skills_to_improve', _skillsToImproveController);
    add('preparation_level', _preparationLevelController);
    add('application_timeline', _applicationTimelineController);
    return context;
  }

  Future<void> _researchPlacement() async {
    if (_auth.user?.isStudent != true ||
        _selectedMode != 'placement' ||
        _loading) {
      return;
    }
    final identity = _authIdentity;
    final goal = _careerGoalController.text.trim();
    if (goal.length < 2 || _placementResearchLoading) return;
    final jobDescription = _jobDescriptionController.text.trim();
    final allowExternalProcessing = _allowExternalProcessing;
    final placementContext = _placementContext();
    final api = AppScope.read(context).api;
    final requestId = ++_placementResearchRequestId;
    setState(() {
      _placementResearchLoading = true;
      _placementResearchError = null;
      _placementResearchResult = null;
    });
    try {
      final roadmapCreated = await _sendMessage(
        'Career goal: $goal',
        placementContext: placementContext,
      );
      if (!roadmapCreated) return;
      final researchGoal = [
        goal,
        if (_companyController.text.trim().isNotEmpty)
          'Company: ${_companyController.text.trim()}',
        if (_targetRoleController.text.trim().isNotEmpty)
          'Role: ${_targetRoleController.text.trim()}',
      ].join('. ');
      final result = await api.researchPlacement(
        careerGoal: researchGoal,
        jobDescription: jobDescription,
        allowExternalProcessing: allowExternalProcessing,
      );
      if (mounted &&
          identity == _authIdentity &&
          requestId == _placementResearchRequestId &&
          _selectedMode == 'placement') {
        setState(() => _placementResearchResult = result);
      }
    } on ApiException catch (error) {
      if (mounted &&
          identity == _authIdentity &&
          requestId == _placementResearchRequestId &&
          _selectedMode == 'placement') {
        setState(() => _placementResearchError = error.message);
      }
    } finally {
      if (mounted &&
          identity == _authIdentity &&
          requestId == _placementResearchRequestId &&
          _selectedMode == 'placement') {
        setState(() => _placementResearchLoading = false);
      }
    }
  }

  Future<void> _analyzePlacementDocument() async {
    final documentId = _placementDocument?['id']?.toString();
    if (documentId == null || documentId.isEmpty || _placementAnalysisLoading) {
      return;
    }
    final identity = _authIdentity;
    setState(() {
      _placementAnalysisLoading = true;
      _placementAnalysisError = null;
    });
    try {
      final result = await AppScope.read(context).api
          .analyzePlacementDocument(documentId);
      if (!mounted || identity != _authIdentity) return;
      setState(() => _placementAnalysis = result);
    } on ApiException catch (error) {
      if (!mounted || identity != _authIdentity) return;
      setState(() => _placementAnalysisError = error.message);
    } finally {
      if (mounted && identity == _authIdentity) {
        setState(() => _placementAnalysisLoading = false);
      }
    }
  }

  Future<void> _analyzePastedJobDescription() async {
    final text = _jobDescriptionController.text.trim();
    if (text.length < 30 || _placementAnalysisLoading) {
      setState(() {
        _placementAnalysisError =
            'Paste at least 30 characters of job description text.';
      });
      return;
    }
    final identity = _authIdentity;
    setState(() {
      _placementAnalysisLoading = true;
      _placementAnalysisError = null;
    });
    try {
      final result = await AppScope.read(context).api
          .analyzePlacementJobDescription(text);
      if (!mounted || identity != _authIdentity) return;
      setState(() => _placementAnalysis = result);
    } on ApiException catch (error) {
      if (!mounted || identity != _authIdentity) return;
      setState(() => _placementAnalysisError = error.message);
    } finally {
      if (mounted && identity == _authIdentity) {
        setState(() => _placementAnalysisLoading = false);
      }
    }
  }

  Future<void> _deletePlacementDocument() async {
    final documentId = _placementDocument?['id']?.toString();
    if (documentId == null || documentId.isEmpty) return;
    final identity = _authIdentity;
    try {
      await AppScope.read(context).api.deletePlacementDocument(documentId);
      if (!mounted || identity != _authIdentity) return;
      setState(() {
        _placementDocument = null;
        _placementAnalysis = null;
        _placementUploadMessage = null;
      });
    } on ApiException catch (error) {
      if (!mounted || identity != _authIdentity) return;
      setState(() => _placementAnalysisError = error.message);
    }
  }

  Widget _placementAnalysisList(String title, String key) {
    final values = _placementAnalysis?[key];
    if (values is! List || values.isEmpty) return const SizedBox.shrink();
    final items = values.whereType<String>().toList();
    if (items.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: Theme.of(context).textTheme.titleSmall),
        ...items.map(
          (item) => Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Text('• $item'),
          ),
        ),
      ],
    );
  }

  Widget _buildPlacementAnalysis() {
    if (_placementAnalysis == null) return const SizedBox.shrink();
    final roadmap = _placementAnalysis!['roadmap'];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Job description analysis',
              style: Theme.of(context).textTheme.titleSmall,
            ),
            _placementAnalysisList(
              'Explicit requirements',
              'explicit_requirements',
            ),
            _placementAnalysisList(
              'Qualifications and eligibility',
              'qualifications_and_eligibility',
            ),
            _placementAnalysisList(
              'Technical skills and tools',
              'technical_skills',
            ),
            _placementAnalysisList(
              'Experience requirements',
              'experience_requirements',
            ),
            _placementAnalysisList('Responsibilities', 'responsibilities'),
            _placementAnalysisList('Interview topics', 'interview_topics'),
            _placementAnalysisList(
              'Additional recommendations (not stated requirements)',
              'additional_recommendations',
            ),
            if (roadmap is List && roadmap.isNotEmpty) ...[
              Text(
                'Suggested roadmap',
                style: Theme.of(context).textTheme.titleSmall,
              ),
              ...roadmap.whereType<Map>().map(
                (item) => Text('Week ${item['week']}: ${item['focus']}'),
              ),
            ],
          ],
        ),
      ),
    );
  }

  String? _safePlacementCitationUrl(Object? rawUrl) {
    if (rawUrl is! String || rawUrl.trim().isEmpty) return null;
    final uri = Uri.tryParse(rawUrl.trim());
    if (uri == null ||
        !{'http', 'https'}.contains(uri.scheme.toLowerCase()) ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty) {
      return null;
    }
    return uri.toString();
  }

  Future<AssistantPickedDocument?> _chooseDocument() async {
    if (widget.filePicker != null) return widget.filePicker!();
    final file = await FilePicker.pickFile(
      type: FileType.custom,
      allowedExtensions: const ['pdf', 'docx', 'txt'],
    );
    if (file == null) return null;
    final size = await file.length();
    if (size == null) {
      throw const ApiException('The selected file size could not be verified.');
    }
    final path = file.path;
    return AssistantPickedDocument(
      name: file.name,
      size: size,
      path: path,
      bytes: path == null && size <= _maxDocumentBytes
          ? await file.readAsBytes()
          : null,
    );
  }

  Future<void> _pickAndUploadDocument({required bool placement}) async {
    if (placement ? _placementUploadLoading : _studyUploadLoading) return;
    final api = AppScope.read(context).api;
    setState(() {
      if (placement) {
        _placementUploadLoading = true;
        _placementUploadError = null;
        _placementUploadMessage = null;
      } else {
        _studyUploadLoading = true;
        _studyUploadError = null;
      }
    });
    final identity = _authIdentity;
    try {
      final selected = await _chooseDocument();
      if (!mounted || selected == null) return;
      if (identity != _authIdentity || _auth.user?.isStudent != true) return;
      final extension = selected.name.contains('.')
          ? selected.name.split('.').last.toLowerCase()
          : '';
      if (!_allowedDocumentExtensions.contains(extension)) {
        throw const ApiException('Choose a PDF, DOCX, or TXT file.');
      }
      if (selected.size <= 0) {
        throw const ApiException('Choose a non-empty document.');
      }
      if (selected.size > _maxDocumentBytes) {
        throw const ApiException('Documents must be 5 MB or smaller.');
      }
      final path = selected.path;
      final bytes = selected.bytes;
      if ((path == null || path.isEmpty) && bytes == null) {
        throw const ApiException(
          'This platform did not provide readable file data for upload.',
        );
      }
      final actualSize = bytes?.length ?? await File(path!).length();
      if (!mounted || identity != _authIdentity) return;
      if (actualSize <= 0) {
        throw const ApiException('Choose a non-empty document.');
      }
      if (actualSize > _maxDocumentBytes) {
        throw const ApiException('Documents must be 5 MB or smaller.');
      }
      if (placement) {
        final result = bytes != null
            ? await api.uploadPlacementDocumentBytes(bytes, selected.name)
            : await api.uploadPlacementDocument(path!);
        if (!mounted || identity != _authIdentity) return;
        setState(() {
          _placementUploadMessage =
              'Private placement document uploaded: ${result['filename'] ?? selected.name}.';
          _placementDocument = result;
          _placementAnalysis = null;
          _placementAnalysisError = null;
        });
      } else {
        final result = bytes != null
            ? await api.uploadStudyDocumentBytes(bytes, selected.name)
            : await api.uploadStudyDocument(path!);
        if (!mounted || identity != _authIdentity) return;
        setState(
          () => _studyDocumentId =
              result['id']?.toString() ?? result['document_id']?.toString(),
        );
        await _loadStudyDocuments();
      }
    } on ApiException catch (error) {
      if (!mounted || identity != _authIdentity) return;
      setState(() {
        if (placement) {
          _placementUploadError = error.message;
        } else {
          _studyUploadError = error.message;
        }
      });
    } on FileSystemException {
      if (!mounted || identity != _authIdentity) return;
      setState(() {
        if (placement) {
          _placementUploadError = 'The selected file could not be read.';
        } else {
          _studyUploadError = 'The selected file could not be read.';
        }
      });
    } on PlatformException catch (error) {
      if (!mounted || identity != _authIdentity) return;
      final message = error.message?.trim();
      setState(() {
        if (placement) {
          _placementUploadError = message == null || message.isEmpty
              ? 'The file could not be selected or uploaded.'
              : message;
        } else {
          _studyUploadError = message == null || message.isEmpty
              ? 'The file could not be selected or uploaded.'
              : message;
        }
      });
    } finally {
      if (mounted && identity == _authIdentity) {
        setState(() {
          if (placement) {
            _placementUploadLoading = false;
          } else {
            _studyUploadLoading = false;
          }
        });
      }
    }
  }

  Future<void> _deleteStudyDocument(Map<String, dynamic> document) async {
    if (_auth.user?.isStudent != true) return;
    final identity = _authIdentity;
    final id = document['id']?.toString();
    if (id == null || id.isEmpty) return;
    final api = AppScope.read(context).api;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Delete study document?'),
        content: Text(
          'Delete ${document['filename'] ?? 'this document'} and its private extracted text?',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted || identity != _authIdentity) return;
    try {
      await api.deleteStudyDocument(id);
      if (!mounted || identity != _authIdentity) return;
      await _loadStudyDocuments();
    } on ApiException catch (error) {
      if (mounted && identity == _authIdentity) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.message)));
      }
    }
  }

  Widget _buildModePicker(bool isStudent, ColorScheme scheme) {
    const options = [
      ('general', 'General Campus Assistant'),
      ('placement', 'Placement Assistant'),
      ('study', 'Study Buddy'),
      ('mood', 'Mood Detector'),
    ];
    final visibleOptions = isStudent ? options : [options.first];
    final modeChips = visibleOptions.map((option) {
      final (value, label) = option;
      return Tooltip(
        message: label,
        child: ChoiceChip(
          label: Text(label),
          selected: _selectedMode == value,
          onSelected: _loading
              ? null
              : (_) {
                  FocusManager.instance.primaryFocus?.unfocus();
                  _selectMode(value);
                },
          side: BorderSide(color: scheme.outlineVariant),
        ),
      );
    }).toList();
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Assistant mode', style: Theme.of(context).textTheme.labelLarge),
          const SizedBox(height: 4),
          if (MediaQuery.sizeOf(context).width < 430)
            DropdownButtonHideUnderline(
              child: DropdownButton<String>(
                key: const Key('assistant_mode_selector'),
                value: _selectedMode,
                isExpanded: true,
                items: visibleOptions
                    .map(
                      (option) => DropdownMenuItem(
                        value: option.$1,
                        child: Text(option.$2),
                      ),
                    )
                    .toList(),
                onChanged: _loading
                    ? null
                    : (value) {
                        if (value != null) {
                          FocusManager.instance.primaryFocus?.unfocus();
                          _selectMode(value);
                        }
                      },
              ),
            )
          else
            Wrap(spacing: 8, runSpacing: 4, children: modeChips),
        ],
      ),
    );
  }

  Widget _buildModeNotice(ColorScheme scheme) {
    if (_selectedMode == 'general') return const SizedBox.shrink();
    if (_selectedMode == 'mood') {
      return Padding(
        padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
        child: Card(
          margin: EdgeInsets.zero,
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Private mood check-in',
                  style: Theme.of(context).textTheme.titleSmall,
                ),
                const SizedBox(height: 4),
                Text(
                  'Voluntary and non-diagnostic. Your check-in is private and separate from assistant chat.',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(height: 8),
                DropdownButtonFormField<String>(
                  key: const Key('assistant_mood_value'),
                  initialValue: _selectedMood,
                  decoration: const InputDecoration(
                    labelText: 'How are you feeling?',
                    border: OutlineInputBorder(),
                  ),
                  items: const [
                    DropdownMenuItem(
                      value: 'very_low',
                      child: Text('Very low'),
                    ),
                    DropdownMenuItem(value: 'low', child: Text('Low')),
                    DropdownMenuItem(value: 'neutral', child: Text('Neutral')),
                    DropdownMenuItem(value: 'good', child: Text('Good')),
                    DropdownMenuItem(
                      value: 'very_good',
                      child: Text('Very good'),
                    ),
                  ],
                  onChanged: _moodCheckInSubmitting
                      ? null
                      : (value) {
                          if (value != null) {
                            setState(() => _selectedMood = value);
                          }
                        },
                ),
                const SizedBox(height: 8),
                TextField(
                  key: const Key('assistant_mood_reflection'),
                  controller: _moodReflectionController,
                  maxLength: 2000,
                  minLines: 1,
                  maxLines: 3,
                  decoration: const InputDecoration(
                    labelText: 'Optional private reflection',
                    border: OutlineInputBorder(),
                  ),
                ),
                Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: FilledButton.icon(
                    key: const Key('assistant_mood_submit'),
                    onPressed: _moodCheckInSubmitting
                        ? null
                        : _submitMoodCheckIn,
                    icon: _moodCheckInSubmitting
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.favorite_border),
                    label: Text(
                      _moodCheckInSubmitting
                          ? 'Saving check-in…'
                          : 'Save private check-in',
                    ),
                  ),
                ),
                if (_moodCheckInError != null)
                  Text(
                    _moodCheckInError!,
                    style: TextStyle(color: scheme.error),
                  ),
                if (_moodCheckInMessage != null) Text(_moodCheckInMessage!),
                if (_moodCheckInLoading) const LinearProgressIndicator(),
                if (_moodCheckIns.isNotEmpty)
                  Text(
                    'Most recent check-in: '
                    '${_moodCheckIns.first['mood'] ?? 'Recorded'}',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: TextButton(
                    onPressed: _openMoodScreen,
                    child: const Text('View private check-in history'),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }
    final isPlacement = _selectedMode == 'placement';
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
      child: Card(
        margin: EdgeInsets.zero,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                isPlacement ? Icons.school_outlined : Icons.menu_book_outlined,
                color: scheme.primary,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      isPlacement ? 'Placement preparation' : 'Study Buddy',
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      isPlacement
                          ? 'Share your target company, role, package, skills and timeline for a tailored roadmap. Research is optional and requires your consent.'
                          : 'Ask questions about uploaded material, explore topic summaries, and generate practice quizzes and flashcards.',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    const SizedBox(height: 10),
                    if (isPlacement)
                      _buildPlacementTools(scheme)
                    else
                      _buildStudyTools(scheme),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildPlacementTools(ColorScheme scheme) {
    final researchAvailable = _placementResearchResult?['available'] == true;
    final researchSources = _placementResearchResult?['sources'];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextField(
          key: const Key('placement_career_goal'),
          controller: _careerGoalController,
          maxLength: 200,
          decoration: const InputDecoration(
            labelText: 'Career goal',
            hintText: 'e.g. data analyst',
            border: OutlineInputBorder(),
          ),
          onChanged: (_) => setState(() {}),
        ),
        TextField(
          key: const Key('placement_company'),
          controller: _companyController,
          maxLength: 120,
          decoration: const InputDecoration(
            labelText: 'Dream company',
            border: OutlineInputBorder(),
          ),
        ),
        TextField(
          key: const Key('placement_role'),
          controller: _targetRoleController,
          maxLength: 120,
          decoration: const InputDecoration(
            labelText: 'Target role',
            border: OutlineInputBorder(),
          ),
        ),
        TextField(
          key: const Key('placement_salary'),
          controller: _salaryController,
          maxLength: 80,
          decoration: const InputDecoration(
            labelText: 'Package or salary goal',
            border: OutlineInputBorder(),
          ),
        ),
        TextField(
          key: const Key('placement_current_skills'),
          controller: _currentSkillsController,
          maxLength: 500,
          decoration: const InputDecoration(
            labelText: 'Current skills',
            border: OutlineInputBorder(),
          ),
        ),
        TextField(
          key: const Key('placement_skills_to_improve'),
          controller: _skillsToImproveController,
          maxLength: 500,
          decoration: const InputDecoration(
            labelText: 'Skills to improve',
            border: OutlineInputBorder(),
          ),
        ),
        TextField(
          key: const Key('placement_preparation_level'),
          controller: _preparationLevelController,
          maxLength: 120,
          decoration: const InputDecoration(
            labelText: 'Preparation level',
            border: OutlineInputBorder(),
          ),
        ),
        TextField(
          key: const Key('placement_application_timeline'),
          controller: _applicationTimelineController,
          maxLength: 120,
          decoration: const InputDecoration(
            labelText: 'Application timeline',
            border: OutlineInputBorder(),
          ),
        ),
        TextField(
          key: const Key('placement_job_description'),
          controller: _jobDescriptionController,
          minLines: 3,
          maxLines: 6,
          maxLength: 10000,
          decoration: const InputDecoration(
            labelText: 'Optional job description',
            hintText: 'Paste job requirements for local analysis',
            border: OutlineInputBorder(),
          ),
        ),
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: OutlinedButton.icon(
            onPressed: _placementAnalysisLoading
                ? null
                : _analyzePastedJobDescription,
            icon: _placementAnalysisLoading
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.analytics_outlined),
            label: const Text('Analyse Job Description'),
          ),
        ),
        CheckboxListTile(
          key: const Key('placement_external_processing_consent'),
          contentPadding: EdgeInsets.zero,
          value: _allowExternalProcessing,
          onChanged: _placementResearchLoading
              ? null
              : (value) =>
                    setState(() => _allowExternalProcessing = value ?? false),
          title: const Text('Allow external processing'),
          subtitle: const Text(
            'Off by default. Only the career goal is sent to web search; pasted or uploaded job-description text stays on this service.',
          ),
          controlAffinity: ListTileControlAffinity.leading,
        ),
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: FilledButton.tonalIcon(
            onPressed:
                _careerGoalController.text.trim().length < 2 ||
                    _placementResearchLoading
                ? null
                : _researchPlacement,
            icon: _placementResearchLoading
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.search),
            label: const Text('Check placement research'),
          ),
        ),
        if (_placementResearchError != null)
          Text(_placementResearchError!, style: TextStyle(color: scheme.error)),
        if (_placementResearchResult != null) ...[
          const SizedBox(height: 6),
          if (researchAvailable) ...[
            Text(
              _placementResearchResult!['summary']?.toString() ??
                  'No research summary was returned.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            if (_placementResearchResult!['date_researched'] is String)
              Text(
                'Researched: ${_placementResearchResult!['date_researched']}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            if (researchSources is List)
              ...researchSources.whereType<Map>().map((source) {
                final url = _safePlacementCitationUrl(source['url']);
                if (url == null) return const SizedBox.shrink();
                final title = source['title']?.toString().trim() ?? '';
                return ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.link),
                  title: Text(title.isEmpty ? url : title),
                  subtitle: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SelectableText(url),
                      if (source['published_at'] is String &&
                          (source['published_at'] as String).isNotEmpty)
                        Text('Published: ${source['published_at']}'),
                      if (source['snippet'] is String)
                        Text(source['snippet'] as String),
                    ],
                  ),
                );
              }),
          ] else ...[
            Text(
              'Placement research unavailable',
              style: Theme.of(context).textTheme.titleSmall,
            ),
            if (_placementResearchResult!['reason'] is String &&
                (_placementResearchResult!['reason'] as String)
                    .trim()
                    .isNotEmpty)
              Text(
                (_placementResearchResult!['reason'] as String).trim(),
                style: Theme.of(context).textTheme.bodySmall,
              ),
          ],
        ],
        const SizedBox(height: 8),
        OutlinedButton.icon(
          onPressed: _placementUploadLoading
              ? null
              : () => _pickAndUploadDocument(placement: true),
          icon: _placementUploadLoading
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.attach_file),
          label: Text(
            _placementUploadLoading
                ? 'Uploading private document…'
                : 'Upload job description or CV',
          ),
        ),
        Text(
          'Supported: PDF, DOCX, TXT; maximum 5 MB. Extracted text stays private and can be analysed locally.',
          style: Theme.of(context).textTheme.bodySmall,
        ),
        if (_placementUploadError != null)
          Text(_placementUploadError!, style: TextStyle(color: scheme.error)),
        if (_placementUploadMessage != null)
          Text(
            _placementUploadMessage!,
            style: TextStyle(color: scheme.primary),
          ),
        if (_placementDocument != null) ...[
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.description_outlined),
            title: Text(
              _placementDocument!['filename']?.toString() ??
                  'Uploaded placement document',
            ),
            subtitle: Text(
              _placementDocument!['summary']?.toString() ??
                  'Private extracted text is ready for analysis.',
            ),
          ),
          Wrap(
            spacing: 8,
            children: [
              OutlinedButton(
                onPressed: _placementAnalysisLoading
                    ? null
                    : _analyzePlacementDocument,
                child: Text(
                  _placementAnalysisLoading
                      ? 'Analysing…'
                      : 'Analyse uploaded document',
                ),
              ),
              TextButton(
                onPressed: _placementAnalysisLoading
                    ? null
                    : _deletePlacementDocument,
                child: const Text('Delete'),
              ),
            ],
          ),
        ],
        if (_placementAnalysisError != null)
          Text(_placementAnalysisError!, style: TextStyle(color: scheme.error)),
        _buildPlacementAnalysis(),
      ],
    );
  }

  Widget _buildStudyTools(ColorScheme scheme) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        OutlinedButton.icon(
          onPressed: _studyUploadLoading
              ? null
              : () => _pickAndUploadDocument(placement: false),
          icon: _studyUploadLoading
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.attach_file),
          label: Text(
            _studyUploadLoading
                ? 'Uploading study document…'
                : 'Add PDF, DOCX or TXT',
          ),
        ),
        Text(
          'Supported: PDF, DOCX, TXT; maximum 5 MB. Selected material is kept private and used only when you ask Study Buddy about it.',
          style: Theme.of(context).textTheme.bodySmall,
        ),
        if (_studyUploadError != null)
          Text(_studyUploadError!, style: TextStyle(color: scheme.error)),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: Text(
                'Your study documents',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.titleSmall,
              ),
            ),
            IconButton(
              tooltip: 'Refresh study documents',
              onPressed: _studyDocumentsLoading ? null : _loadStudyDocuments,
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        if (_studyDocumentsLoading) const LinearProgressIndicator(),
        if (_studyDocumentsError != null)
          Text(_studyDocumentsError!, style: TextStyle(color: scheme.error)),
        if (!_studyDocumentsLoading &&
            _studyDocumentsError == null &&
            _studyDocuments.isEmpty)
          const Text('No study documents yet.'),
        if (_studyDocuments.isNotEmpty)
          DropdownButton<String>(
            key: const Key('study_document_selector'),
            isExpanded: true,
            value: _studyDocumentId,
            hint: const Text('Choose material for this conversation'),
            items: _studyDocuments
                .map(
                  (document) => DropdownMenuItem(
                    value: document['id']?.toString(),
                    child: Text(
                      document['filename']?.toString() ?? 'Study document',
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                )
                .toList(),
            onChanged: (value) => setState(() => _studyDocumentId = value),
          ),
        ..._studyDocuments.map((document) {
          final id = document['id']?.toString() ?? '';
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(
                  document['filename']?.toString() ?? 'Study document',
                ),
                subtitle: Text(document['summary']?.toString() ?? ''),
                selected: _studyDocumentId == id,
                onTap: () => setState(() => _studyDocumentId = id),
              ),
              Wrap(
                spacing: 4,
                runSpacing: 4,
                children: [
                  TextButton.icon(
                    onPressed: () => _analyzeStudyDocument(document),
                    icon: const Icon(Icons.analytics_outlined),
                    label: const Text('Analyse'),
                  ),
                  TextButton.icon(
                    onPressed: _quizLoadingId == id
                        ? null
                        : () => _generateStudyQuiz(document),
                    icon: _quizLoadingId == id
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.quiz_outlined),
                    label: const Text('Practice quiz'),
                  ),
                  TextButton.icon(
                    onPressed: _flashcardsLoadingId == id
                        ? null
                        : () => _generateStudyFlashcards(document),
                    icon: _flashcardsLoadingId == id
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.style_outlined),
                    label: const Text('Flashcards'),
                  ),
                  IconButton(
                    tooltip:
                        'Delete ${document['filename'] ?? 'study document'}',
                    onPressed: () => _deleteStudyDocument(document),
                    icon: const Icon(Icons.delete_outline),
                  ),
                ],
              ),
            ],
          );
        }),
      ],
    );
  }

  void _openMoodScreen() {
    Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => const MoodScreen()));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final isStudent = AppScope.of(context).auth.user?.isStudent == true;
    final compact = MediaQuery.sizeOf(context).width < 430;
    final keyboardOpen = MediaQuery.viewInsetsOf(context).bottom > 0;
    final modePanelMaxHeight = (MediaQuery.sizeOf(context).height * 0.3)
        .clamp(120.0, 200.0)
        .toDouble();

    return Scaffold(
      resizeToAvoidBottomInset: true,
      appBar: AppBar(
        title: compact
            ? const Text('AI Assistant')
            : Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('AI Campus Assistant'),
                  Text(
                    'Grounded Official Records',
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: scheme.primary,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
        actions: [
          PopupMenuButton<String>(
            tooltip: 'Select Day for Query',
            icon: const Icon(Icons.calendar_today_rounded),
            initialValue: _selectedDay,
            onSelected: (val) {
              setState(() => _selectedDay = val);
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(
                  content: Text('Target day set to $val'),
                  duration: const Duration(seconds: 1),
                ),
              );
            },
            itemBuilder: (ctx) => weekDays
                .map((d) => PopupMenuItem(value: d, child: Text(d)))
                .toList(),
          ),
          if (!compact)
            IconButton(
              tooltip: 'Clear Chat',
              icon: const Icon(Icons.delete_sweep_outlined),
              onPressed: _clearConversation,
            ),
          if (!compact)
            IconButton(
              tooltip: 'New Conversation',
              icon: const Icon(Icons.add_comment_outlined),
              onPressed: _newConversation,
            ),
          if (!compact)
            IconButton(
              tooltip: 'Read Latest Response',
              icon: const Icon(Icons.volume_up_outlined),
              onPressed: _speakLatestResponse,
            ),
          if (compact)
            PopupMenuButton<String>(
              tooltip: 'More assistant options',
              icon: const Icon(Icons.more_vert),
              itemBuilder: (context) => [
                const PopupMenuItem(
                  value: 'clear',
                  child: ListTile(
                    leading: Icon(Icons.delete_sweep_outlined),
                    title: Text('Clear chat'),
                    contentPadding: EdgeInsets.zero,
                  ),
                ),
                const PopupMenuItem(
                  value: 'new',
                  child: ListTile(
                    leading: Icon(Icons.add_comment_outlined),
                    title: Text('New conversation'),
                    contentPadding: EdgeInsets.zero,
                  ),
                ),
                const PopupMenuItem(
                  value: 'speak',
                  child: ListTile(
                    leading: Icon(Icons.volume_up_outlined),
                    title: Text('Read latest response'),
                    contentPadding: EdgeInsets.zero,
                  ),
                ),
                const PopupMenuItem(
                  value: 'mood',
                  child: ListTile(
                    leading: Icon(Icons.favorite_border),
                    title: Text('Mood and wellbeing (private)'),
                    contentPadding: EdgeInsets.zero,
                  ),
                ),
                const PopupMenuItem(
                  value: 'complaint',
                  child: ListTile(
                    leading: Icon(Icons.report_outlined),
                    title: Text('Prepare Complaint'),
                    contentPadding: EdgeInsets.zero,
                  ),
                ),
                if (isStudent)
                  const PopupMenuItem(
                    value: 'placement',
                    child: ListTile(
                      leading: Icon(Icons.school_outlined),
                      title: Text('Placement Practice'),
                      contentPadding: EdgeInsets.zero,
                    ),
                  ),
              ],
              onSelected: (value) {
                switch (value) {
                  case 'clear':
                    _clearConversation();
                  case 'new':
                    _newConversation();
                  case 'speak':
                    _speakLatestResponse();
                  case 'mood':
                    _openMoodScreen();
                  case 'complaint':
                    _prepareComplaint();
                  case 'placement':
                    _startPlacementPractice();
                }
              },
            ),
          if (!compact)
            PopupMenuButton<String>(
              tooltip: 'More assistant options',
              icon: const Icon(Icons.more_vert),
              itemBuilder: (context) => [
                const PopupMenuItem(
                  value: 'mood',
                  child: ListTile(
                    leading: Icon(Icons.favorite_border),
                    title: Text('Mood and wellbeing (private)'),
                    contentPadding: EdgeInsets.zero,
                  ),
                ),
                const PopupMenuItem(
                  value: 'complaint',
                  child: ListTile(
                    leading: Icon(Icons.report_outlined),
                    title: Text('Prepare Complaint'),
                    contentPadding: EdgeInsets.zero,
                  ),
                ),
                if (isStudent)
                  const PopupMenuItem(
                    value: 'placement',
                    child: ListTile(
                      leading: Icon(Icons.school_outlined),
                      title: Text('Placement Practice'),
                      contentPadding: EdgeInsets.zero,
                    ),
                  ),
              ],
              onSelected: (value) {
                switch (value) {
                  case 'mood':
                    _openMoodScreen();
                  case 'complaint':
                    _prepareComplaint();
                  case 'placement':
                    _startPlacementPractice();
                }
              },
            ),
          PopupMenuButton<String>(
            tooltip: 'Saved Conversations',
            icon: const Icon(Icons.history),
            itemBuilder: (context) => _conversations.isEmpty
                ? [
                    const PopupMenuItem<String>(
                      value: '',
                      child: Text('No saved conversations'),
                    ),
                  ]
                : _conversations.map((conversation) {
                    return PopupMenuItem<String>(
                      value: conversation['id']?.toString(),
                      child: Text(
                        conversation['title']?.toString() ?? 'Conversation',
                      ),
                    );
                  }).toList(),
            onSelected: (id) {
              if (id.isNotEmpty) _loadConversation(id);
            },
          ),
        ],
      ),
      body: Column(
        children: [
          _buildModePicker(isStudent, scheme),
          if (!keyboardOpen)
            ConstrainedBox(
              constraints: BoxConstraints(maxHeight: modePanelMaxHeight),
              child: SingleChildScrollView(
                child: Column(
                  children: [
                    _buildModeNotice(scheme),
                    if (_conversationError != null)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
                        child: Card(
                          margin: EdgeInsets.zero,
                          child: ListTile(
                            leading: Icon(
                              Icons.history_toggle_off,
                              color: scheme.error,
                            ),
                            title: const Text(
                              'Conversation history unavailable',
                            ),
                            subtitle: Text(_conversationError!),
                            trailing: TextButton(
                              onPressed: _loadConversations,
                              child: const Text('Retry'),
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          if (!keyboardOpen)
            Container(
              height: 48,
              decoration: BoxDecoration(
                color: scheme.surfaceContainerHighest.withValues(alpha: 0.3),
                border: Border(
                  bottom: BorderSide(color: scheme.outlineVariant),
                ),
              ),
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 8,
                ),
                itemCount: _suggestionsForMode().length,
                separatorBuilder: (_, _) => const SizedBox(width: 8),
                itemBuilder: (context, index) {
                  final question = _suggestionsForMode()[index];
                  return ActionChip(
                    label: Text(
                      question,
                      style: TextStyle(
                        fontSize: 12,
                        color: scheme.onSurfaceVariant,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    onPressed: _loading ? null : () => _sendMessage(question),
                  );
                },
              ),
            ),

          // Chat message list
          Expanded(
            child: ListView.builder(
              controller: _scrollController,
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
              itemCount: _messages.length,
              itemBuilder: (context, index) {
                final msg = _messages[index];
                return _buildMessageBubble(msg, scheme, theme);
              },
            ),
          ),

          // Loading indicator
          if (_loading)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 6),
              child: Row(
                children: [
                  const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                  const SizedBox(width: 10),
                  Text(
                    'Campus Assistant is checking records...',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),

          // Input Bar
          Container(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
            decoration: BoxDecoration(
              color: scheme.surface,
              border: Border(top: BorderSide(color: scheme.outlineVariant)),
            ),
            child: SafeArea(
              top: false,
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _controller,
                      textInputAction: TextInputAction.send,
                      onSubmitted: _sendMessage,
                      decoration: InputDecoration(
                        hintText: 'Message the assistant…',
                        hintStyle: TextStyle(
                          fontSize: 14,
                          color: scheme.onSurfaceVariant.withValues(alpha: 0.7),
                        ),
                        isDense: true,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 16,
                          vertical: 12,
                        ),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(24),
                          borderSide: BorderSide(color: scheme.outlineVariant),
                        ),
                        filled: true,
                        fillColor: scheme.surfaceContainerHigh,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton(
                    tooltip: _listening
                        ? 'Stop Voice Input'
                        : 'Start Voice Input',
                    icon: Icon(
                      _listening
                          ? Icons.stop_circle_outlined
                          : Icons.mic_outlined,
                    ),
                    onPressed: _loading
                        ? null
                        : () => _listening
                              ? _stopVoiceInput()
                              : _startVoiceInput(),
                  ),
                  IconButton.filled(
                    tooltip: 'Send',
                    icon: const Icon(Icons.arrow_upward_rounded),
                    onPressed: _loading
                        ? null
                        : () => _sendMessage(_controller.text),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildMessageBubble(
    _ChatMessage msg,
    ColorScheme scheme,
    ThemeData theme,
  ) {
    final isUser = msg.isUser;
    final bg = isUser ? scheme.primary : scheme.surfaceContainerHigh;
    final fg = isUser ? scheme.onPrimary : scheme.onSurface;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        mainAxisAlignment: isUser
            ? MainAxisAlignment.end
            : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!isUser) ...[
            CircleAvatar(
              radius: 16,
              backgroundColor: scheme.primaryContainer,
              child: Icon(
                Icons.smart_toy_rounded,
                size: 18,
                color: scheme.onPrimaryContainer,
              ),
            ),
            const SizedBox(width: 8),
          ],
          Flexible(
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              decoration: BoxDecoration(
                color: bg,
                borderRadius: BorderRadius.only(
                  topLeft: const Radius.circular(18),
                  topRight: const Radius.circular(18),
                  bottomLeft: Radius.circular(isUser ? 18 : 4),
                  bottomRight: Radius.circular(isUser ? 4 : 18),
                ),
                border: !isUser
                    ? Border.all(color: scheme.outlineVariant)
                    : null,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    msg.text,
                    style: TextStyle(color: fg, fontSize: 14.5, height: 1.4),
                  ),
                  if (msg.sources.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Text(
                      'Sources: ${msg.sources.join(' · ')}',
                      style: theme.textTheme.bodySmall?.copyWith(color: fg),
                    ),
                  ],
                  if (msg.suggestions.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: msg.suggestions
                          .map(
                            (suggestion) => ActionChip(
                              label: Text(suggestion),
                              onPressed: _loading
                                  ? null
                                  : () => _sendMessage(suggestion),
                            ),
                          )
                          .toList(),
                    ),
                  ],
                  if (msg.requiresConfirmation &&
                      msg.confirmationId != null) ...[
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        TextButton(
                          onPressed: () => _confirmAction(msg.confirmationId!),
                          child: const Text('Confirm'),
                        ),
                        TextButton(
                          onPressed: () => _cancelAction(msg.confirmationId!),
                          child: const Text('Cancel'),
                        ),
                      ],
                    ),
                  ],
                  if (!isUser)
                    Align(
                      alignment: AlignmentDirectional.centerEnd,
                      child: Wrap(
                        spacing: 4,
                        children: [
                          if (msg.retryQuery != null)
                            TextButton.icon(
                              onPressed: _loading
                                  ? null
                                  : () => _retryMessage(msg),
                              icon: const Icon(Icons.refresh, size: 16),
                              label: const Text('Try again'),
                            ),
                          IconButton(
                            tooltip: 'Copy response',
                            visualDensity: VisualDensity.compact,
                            onPressed: () async {
                              await Clipboard.setData(
                                ClipboardData(text: msg.text),
                              );
                              if (mounted) {
                                ScaffoldMessenger.of(context).showSnackBar(
                                  const SnackBar(
                                    content: Text('Response copied.'),
                                    duration: Duration(seconds: 1),
                                  ),
                                );
                              }
                            },
                            icon: const Icon(Icons.copy, size: 18),
                          ),
                        ],
                      ),
                    ),
                  if (msg.intent != null) ...[
                    const SizedBox(height: 6),
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 6,
                            vertical: 2,
                          ),
                          decoration: BoxDecoration(
                            color: scheme.primary.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Text(
                            msg.intent!.toUpperCase(),
                            style: TextStyle(
                              fontSize: 9,
                              fontWeight: FontWeight.w700,
                              color: scheme.primary,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ),
          if (isUser) const SizedBox(width: 8),
        ],
      ),
    );
  }
}
