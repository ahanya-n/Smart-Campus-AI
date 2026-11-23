import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
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
  });

  final String name;
  final int size;
  final String? path;
}

class _ChatMessage {
  _ChatMessage({
    required this.text,
    required this.isUser,
    required this.time,
    this.intent,
    this.provider,
    this.action,
    this.requiresConfirmation = false,
    this.confirmationId,
  });

  final String text;
  final bool isUser;
  final DateTime time;
  final String? intent;
  final String? provider;
  final Map<String, dynamic>? action;
  final bool requiresConfirmation;
  final String? confirmationId;
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
  final TextEditingController _jobDescriptionController =
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
  List<Map<String, dynamic>> _conversations = [];
  final Map<String, String> _conversationModes = {};
  List<Map<String, dynamic>> _studyDocuments = [];
  bool _studyDocumentsLoading = false;
  bool _studyUploadLoading = false;
  String? _studyDocumentsError;
  String? _studyUploadError;
  String? _quizLoadingId;
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
    _jobDescriptionController.dispose();
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
    _loading = false;
    _conversationModes.clear();
    _conversations = [];
    _studyDocuments = [];
    _studyDocumentsLoading = false;
    _studyUploadLoading = false;
    _studyDocumentsError = null;
    _studyUploadError = null;
    _quizLoadingId = null;
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

  Future<void> _sendMessage(String text) async {
    final query = text.trim();
    if (query.isEmpty || _loading) return;
    final isStudent = _auth.user?.isStudent == true;
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
      if (_selectedMode == 'study' && _studyDocuments.isNotEmpty) {
        documentId = _studyDocuments.first['id']?.toString();
      } else if (_selectedMode == 'placement') {
        documentId = _placementDocument?['id']?.toString();
      }
      final res = await api.askAssistant(
        query,
        mode: isStudent ? _selectedMode : 'general',
        day: _selectedDay,
        history: history,
        conversationId: _conversationId,
        documentId: documentId,
      );
      if (!mounted || requestIdentity != _authIdentity) return;
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
      var reply = res['reply']?.toString() ?? 'No response received.';
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
    } on ApiException catch (e) {
      if (mounted && requestIdentity == _authIdentity) {
        setState(() {
          _messages.add(
            _ChatMessage(
              text: '⚠️ ${e.message}',
              isUser: false,
              time: DateTime.now(),
            ),
          );
        });
        _scrollToBottom();
      }
    } finally {
      if (mounted && requestIdentity == _authIdentity) {
        setState(() => _loading = false);
      }
    }
  }

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
    try {
      final items = await api.listAssistantConversations();
      if (!mounted || identity != _authIdentity) return;
      setState(() {
        _conversations = items
            .where(
              (conversation) =>
                  _modeForConversation(conversation) == _selectedMode,
            )
            .toList();
      });
    } on ApiException {
      // The chat remains usable if the conversation list is unavailable.
    }
  }

  String _modeForConversation(Map<String, dynamic> conversation) {
    final id = conversation['id']?.toString() ?? '';
    final mode = conversation['mode']?.toString() ?? _conversationModes[id];
    return _normalizeConversationMode(mode ?? 'general');
  }

  String _normalizeConversationMode(String mode) => switch (mode) {
    'study_buddy' => 'study',
    'general' || 'placement' || 'study' => mode,
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
      final conversation = await api.createAssistantConversation();
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
        setState(() => _studyDocuments = documents);
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
      final topics = result['chapter_topic_analysis'] is Map
          ? (Map<String, dynamic>.from(
                      result['chapter_topic_analysis'] as Map,
                    )['main_topics']
                    as List? ??
                const [])
          : const [];
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
                  const Text('Main topics'),
                  ...topics.map((topic) => Text('• $topic')),
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
      final questions = (result['questions'] as List?) ?? const [];
      await showDialog<void>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: Text('Quiz: ${document['filename'] ?? 'Study material'}'),
          content: SizedBox(
            width: 440,
            child: questions.isEmpty
                ? const Text(
                    'No quiz questions could be generated from this document.',
                  )
                : SingleChildScrollView(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: questions.whereType<Map>().map((rawQuestion) {
                        final question = rawQuestion.map(
                          (key, value) => MapEntry(key.toString(), value),
                        );
                        return Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(question['question']?.toString() ?? ''),
                              const SizedBox(height: 4),
                              Text('Answer: ${question['answer'] ?? ''}'),
                            ],
                          ),
                        );
                      }).toList(),
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

  Future<void> _researchPlacement() async {
    if (_auth.user?.isStudent != true || _selectedMode != 'placement') return;
    final identity = _authIdentity;
    final goal = _careerGoalController.text.trim();
    if (goal.length < 2 || _placementResearchLoading) return;
    final jobDescription = _jobDescriptionController.text.trim();
    final allowExternalProcessing = _allowExternalProcessing;
    final requestId = ++_placementResearchRequestId;
    setState(() {
      _placementResearchLoading = true;
      _placementResearchError = null;
      _placementResearchResult = null;
    });
    try {
      final result = await AppScope.read(context).api.researchPlacement(
        careerGoal: goal,
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
    return AssistantPickedDocument(
      name: file.name,
      size: size,
      path: file.path,
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
      if (path == null || path.isEmpty) {
        throw const ApiException(
          'This platform did not provide a local file path for upload.',
        );
      }
      final actualSize = await File(path).length();
      if (!mounted || identity != _authIdentity) return;
      if (actualSize <= 0) {
        throw const ApiException('Choose a non-empty document.');
      }
      if (actualSize > _maxDocumentBytes) {
        throw const ApiException('Documents must be 5 MB or smaller.');
      }
      if (placement) {
        final result = await api.uploadPlacementDocument(path);
        if (!mounted || identity != _authIdentity) return;
        setState(() {
          _placementUploadMessage =
              'Private placement document uploaded: ${result['filename'] ?? selected.name}.';
          _placementDocument = result;
          _placementAnalysis = null;
          _placementAnalysisError = null;
        });
      } else {
        await api.uploadStudyDocument(path);
        if (!mounted || identity != _authIdentity) return;
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
    } catch (_) {
      if (!mounted || identity != _authIdentity) return;
      setState(() {
        if (placement) {
          _placementUploadError = 'The file could not be selected or uploaded.';
        } else {
          _studyUploadError = 'The file could not be selected or uploaded.';
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
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Assistant mode', style: Theme.of(context).textTheme.labelLarge),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 4,
            children: visibleOptions.map((option) {
              final (value, label) = option;
              return Tooltip(
                message: label,
                child: ChoiceChip(
                  label: Text(label),
                  selected: _selectedMode == value,
                  onSelected: _loading ? null : (_) => _selectMode(value),
                  side: BorderSide(color: scheme.outlineVariant),
                ),
              );
            }).toList(),
          ),
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
          child: ListTile(
            leading: const Icon(Icons.favorite_border),
            title: const Text('Mood Detector'),
            subtitle: const Text(
              'Check in voluntarily. Private mood history is available in the Mood and wellbeing page and is not mixed into chat conversation history.',
            ),
            trailing: TextButton(
              onPressed: _openMoodScreen,
              child: const Text('Open check-in'),
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
                          ? 'The mode is included in chat requests; replies follow current server behavior. Placement practice is available; research results appear only when returned by the service.'
                          : 'The mode is included in chat requests; replies follow current server behavior. Private saved study documents and service-generated quizzes appear here.',
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
          'Supported: PDF, DOCX, TXT; maximum 5 MB. Documents stay private and are not added to chat.',
          style: Theme.of(context).textTheme.bodySmall,
        ),
        if (_studyUploadError != null)
          Text(_studyUploadError!, style: TextStyle(color: scheme.error)),
        const SizedBox(height: 8),
        Row(
          children: [
            Text(
              'Your study documents',
              style: Theme.of(context).textTheme.titleSmall,
            ),
            const Spacer(),
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
        ..._studyDocuments.map((document) {
          final id = document['id']?.toString() ?? '';
          return ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(document['filename']?.toString() ?? 'Study document'),
            subtitle: Text(document['summary']?.toString() ?? ''),
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                IconButton(
                  tooltip:
                      'Analyse ${document['filename'] ?? 'study document'}',
                  onPressed: () => _analyzeStudyDocument(document),
                  icon: const Icon(Icons.analytics_outlined),
                ),
                IconButton(
                  tooltip:
                      'Generate quiz for ${document['filename'] ?? 'study document'}',
                  onPressed: _quizLoadingId == id
                      ? null
                      : () => _generateStudyQuiz(document),
                  icon: _quizLoadingId == id
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.quiz_outlined),
                ),
                IconButton(
                  tooltip: 'Delete ${document['filename'] ?? 'study document'}',
                  onPressed: () => _deleteStudyDocument(document),
                  icon: const Icon(Icons.delete_outline),
                ),
              ],
            ),
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

    return Scaffold(
      appBar: AppBar(
        title: Column(
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
          IconButton(
            tooltip: 'Clear Chat',
            icon: const Icon(Icons.delete_sweep_outlined),
            onPressed: _clearConversation,
          ),
          IconButton(
            tooltip: 'New Conversation',
            icon: const Icon(Icons.add_comment_outlined),
            onPressed: _newConversation,
          ),
          IconButton(
            tooltip: 'Read Latest Response',
            icon: const Icon(Icons.volume_up_outlined),
            onPressed: _speakLatestResponse,
          ),
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
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 210),
            child: SingleChildScrollView(
              child: Column(
                children: [
                  _buildModePicker(isStudent, scheme),
                  _buildModeNotice(scheme),
                ],
              ),
            ),
          ),
          // Suggested questions quick scroll
          Container(
            height: 48,
            decoration: BoxDecoration(
              color: scheme.surfaceContainerHighest.withValues(alpha: 0.3),
              border: Border(bottom: BorderSide(color: scheme.outlineVariant)),
            ),
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              itemCount: _suggestedQuestions.length,
              separatorBuilder: (_, _) => const SizedBox(width: 8),
              itemBuilder: (context, index) {
                final question = _suggestedQuestions[index];
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
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _controller,
                      textInputAction: TextInputAction.send,
                      onSubmitted: _sendMessage,
                      decoration: InputDecoration(
                        hintText: 'Ask about your academics or timetable...',
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
