import 'package:flutter/material.dart';

import '../app_scope.dart';
import '../models/timetable.dart';
import '../services/api_service.dart';

class _ChatMessage {
  _ChatMessage({
    required this.text,
    required this.isUser,
    required this.time,
    this.intent,
    this.provider,
  });

  final String text;
  final bool isUser;
  final DateTime time;
  final String? intent;
  final String? provider;
}

class CampusAssistantScreen extends StatefulWidget {
  const CampusAssistantScreen({super.key, this.initialQuery});

  final String? initialQuery;

  @override
  State<CampusAssistantScreen> createState() => _CampusAssistantScreenState();
}

class _CampusAssistantScreenState extends State<CampusAssistantScreen> {
  final TextEditingController _controller = TextEditingController();
  final ScrollController _scrollController = ScrollController();

  final List<_ChatMessage> _messages = [];
  bool _loading = false;
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
    _messages.add(
      _ChatMessage(
        text: 'Hello! I am your AI Campus Assistant. Ask me anything about your attendance, daily schedule, upcoming classes, or free time windows.',
        isUser: false,
        time: DateTime.now(),
        provider: 'grounded_rule_engine',
      ),
    );

    if (widget.initialQuery != null && widget.initialQuery!.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _sendMessage(widget.initialQuery!);
      });
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    _scrollController.dispose();
    super.dispose();
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
      final historyStart = (_messages.length - 8).clamp(0, _messages.length).toInt();
      final history = _messages.sublist(historyStart).map((message) {
        return <String, dynamic>{
          'role': message.isUser ? 'user' : 'assistant',
          'content': message.text,
          if (!message.isUser && message.intent != null)
            'intent': message.intent,
        };
      }).toList();
      final res = await api.askAssistant(
        query,
        day: _selectedDay,
        history: history,
      );
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
            ),
          );
        });
        _scrollToBottom();
      }
    } on ApiException catch (e) {
      if (mounted) {
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
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

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
            onPressed: () {
              setState(() {
                _messages.clear();
                _messages.add(
                  _ChatMessage(
                    text: 'Chat cleared. Ask about your attendance, timetable, or free time.',
                    isUser: false,
                    time: DateTime.now(),
                  ),
                );
              });
            },
          ),
        ],
      ),
      body: Column(
        children: [
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
